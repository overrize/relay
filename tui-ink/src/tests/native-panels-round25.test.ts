import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SessionScreen} from '../tui/native/SessionScreen.js';
import {NativeKeys} from '../tui/native/NativeKeys.js';
import {budgetPanel,parseAuditFilter} from '../tui/native/Panels.js';
import {SessionJournal} from '../session/Journal.js';
import {transcriptPage} from '../session/Transcript.js';
import {backgroundAuditReport} from '../session/BackgroundAudit.js';
import {stripTerminalSequences,visibleWidth,type Terminal} from '@code-yeongyu/senpi-tui';

class TerminalFixture implements Terminal{
 columns=90;rows=24;kittyProtocolActive=false;output='';input:(s:string)=>void=()=>{};resize:()=>void=()=>{};
 start(input:(s:string)=>void,resize:()=>void){this.input=input;this.resize=resize;}stop(){this.input=()=>{};}async drainInput(){}write(s:string){this.output+=s;}moveBy(_n:number){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(_s:string){}setProgress(_a:boolean){}
}
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/native25-')),old=process.env.SPAWN_CONFIG_DIR;
process.env.SPAWN_CONFIG_DIR=path.join(root,'config');fs.mkdirSync(process.env.SPAWN_CONFIG_DIR,{recursive:true});
after(()=>{if(old===undefined)delete process.env.SPAWN_CONFIG_DIR;else process.env.SPAWN_CONFIG_DIR=old;fs.rmSync(root,{recursive:true,force:true});});
const mapping={'app.history.search':'f2','app.viewport.up':'f3','app.clear':'ctrl+x','tui.input.submit':'ctrl+s','tui.select.down':'ctrl+j'};
fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR,'keybindings.json'),JSON.stringify(mapping));
const until=async(check:()=>boolean)=>{const deadline=Date.now()+15000;while(!check()){assert.ok(Date.now()<deadline,'UI read timeout');await new Promise(r=>setTimeout(r,15));}};

test('native keys handle CSI-u, disabled defaults, selector scope and bracketed paste atomically',()=>{
 const keys=new NativeKeys();keys.reload();assert.equal(keys.translate('\x1bOQ','compose').action,'app.history.search');assert.equal(keys.translate('\x1b[114;5u','compose').data,'');
 assert.equal(keys.translate('\x1bn','compose').action,'app.panel.more');assert.equal(keys.translate('\x1bp','compose').action,'app.model.cycleBackward');assert.equal(keys.translate('\x1b[1;3B','compose').action,'app.panel.next');
 assert.equal(keys.translate('\x13','compose').action,'tui.input.submit');assert.equal(keys.translate('\r','compose').data,'');assert.equal(keys.translate('\n','model').data,'\x1b[B');
 const paste='\x1b[200~中文\x12\x03\n文本\x1b[201~';assert.equal(keys.translate(paste,'compose').data,paste);
 const before=keys.bindings.report();fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!,'keybindings.json'),JSON.stringify({'app.history.search':'ctrl+l'}));assert.throws(()=>keys.reload(),/冲突/);assert.equal(keys.bindings.report(),before);fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!,'keybindings.json'),JSON.stringify(mapping));
});

test('fixed composer survives scroll, background append, panel navigation, remapped submit and resize',async()=>{
 const retained=new SessionJournal(root,{automatic:false});retained.bind('pm','Leader');retained.append('message.recorded','pm','pm',0,{role:'user',content:'UI_OLD_RETAINED'});
 const state:any={revision:2,goal:'CURRENT_GOAL',agents:[{id:'pm',model:'fixture',activity:'tool-running'}],inputs:[],messages:Array.from({length:100},(_,i)=>({agent:'pm',text:`MESSAGE_${i} 中文🙂`,ts:i})),history:[],tasks:[],budget:{note:'尚未初始化'},recoverable:false,model:'fixture'};
 let listener:(s:any)=>void=()=>{},interrupts=0;const sent:string[]=[];const controller:any={snapshot:()=>structuredClone(state),subscribe:(fn:any)=>{listener=fn;fn(state);return()=>{};},send:(s:string)=>sent.push(s),interrupt:()=>interrupts++,shutdown:async()=>{},modelChoices:()=>[],audit:()=>backgroundAuditReport(root),transcript:(before?:number)=>transcriptPage(root,before)};
 const term=new TerminalFixture(),screen=new SessionScreen(term,controller);screen.start();
 const lines=()=>{screen.tui.renderNow();return screen.tui.getScreenLines().map(stripTerminalSequences);};
 try{
  term.input('草稿🙂');let frame=lines(),cursorRow=frame.findIndex(l=>l.includes('草稿🙂'));assert.ok(cursorRow>=term.rows-8);const bottom=screen.viewport.scrollTop;term.input('\x1bOR');lines();assert.ok(screen.viewport.scrollTop<bottom);const top=screen.viewport.scrollTop;
  state.messages.push({agent:'pm',text:'BACKGROUND_NEW',ts:101});listener(state);frame=lines();assert.equal(screen.viewport.scrollTop,top);assert.equal(frame.findIndex(l=>l.includes('草稿🙂')),cursorRow);assert.equal(screen.editor.getText(),'草稿🙂');
  assert.ok(screen.submit('/tasks'));frame=lines();assert.match(frame.join('\n'),/任务面板/);term.input('\x1b');assert.equal(interrupts,0);assert.equal(screen.editor.getText(),'草稿🙂');
  screen.submit('/budget');assert.match(lines().join('\n'),/预算面板/);screen.submit('/chat');term.input('\r');assert.equal(sent.length,0);term.input('\x13');assert.deepEqual(sent,['草稿🙂']);
  term.input('保留光标🙂');term.input('\x1b[D');const cursor=screen.editor.getCursor();term.input('\x1bOQ');term.input('\x1b');assert.deepEqual(screen.editor.getCursor(),cursor);assert.equal(screen.editor.getText(),'保留光标🙂');
  term.input('\x03');assert.equal(screen.editor.getText(),'保留光标🙂');term.columns=42;term.rows=16;term.resize();frame=lines();assert.equal(frame.length,16);assert.ok(frame.some(l=>l.includes('保留光标')));for(const l of frame)assert.ok(visibleWidth(l)<=42);
  screen.submit('/audit');await until(()=>{lines();return screen.tui.getScreenLines().some(l=>l.includes('长期审计'));});assert.equal(screen.editor.getText(),'保留光标🙂');term.input('\x1b');assert.equal(interrupts,0);
  await screen.loadOlder();assert.match(lines().join('\n'),/UI_OLD_RETAINED/);assert.equal(screen.editor.getText(),'保留光标🙂');
 }finally{await screen.close();}
});

test('retained transcript pages exceed the 50-message projection, have stable cursors and never repeat rows',async()=>{
 const historyRoot=path.join(root,'pagination'),j=new SessionJournal(historyRoot,{automatic:false});j.bind('pm','Leader');for(let i=0;i<175;i++)j.append('message.recorded','pm','pm',0,{role:i%2?'assistant':'user',content:`PERSISTENT_${i}`});assert.equal(j.history('pm').length,50);
 const first=await transcriptPage(historyRoot),second=await transcriptPage(historyRoot,first.nextBefore);assert.equal(first.rows.length,80);assert.equal(second.rows.length,80);assert.equal(first.rows.at(-1)?.text,'PERSISTENT_174');assert.equal(new Set([...first.rows,...second.rows].map(r=>r.seq)).size,160);
 const last=await transcriptPage(historyRoot,second.nextBefore);assert.equal(last.rows.length,15);assert.equal(last.nextBefore,undefined);assert.equal(last.rows[0].text,'PERSISTENT_0');
 assert.throws(()=>transcriptPage(historyRoot,undefined,NaN),/INVALID_HISTORY_LIMIT/);j.append('message.recorded','pm','pm',0,{role:'assistant',content:'L'.repeat(60000)});const bounded=await transcriptPage(historyRoot,undefined,1);assert.ok(bounded.rows[0].text.length<25000);assert.match(bounded.rows[0].text,/长内容已截取/);
 assert.deepEqual(parseAuditFilter('model=x task=y before=10 limit=20'),{model:'x',task:'y',before:10,limit:20});assert.throws(()=>parseAuditFilter('limit=0'));assert.throws(()=>parseAuditFilter('before=NaN'));
 const text=budgetPanel({budget:{used:{requests:1,tools:0,tokens:9,microUsd:0},limits:{requests:10,tools:4,tokens:99,microUsd:0},unpricedApiRequests:1,pendingOrUncertain:0},tasks:[]} as any);assert.match(text,/未知费用/);assert.match(text,/不等于免费/);
});

test('loading older pages while new output arrives never advances the live-message cutoff',async()=>{
 const state:any={revision:0,goal:'',agents:[],inputs:[],messages:[],history:[],tasks:[],budget:{note:'none'},recoverable:false,model:'fixture'};let page=0;
 const c:any={snapshot:()=>structuredClone(state),subscribe:(f:any)=>{f(state);return()=>{};},shutdown:async()=>{},transcript:async()=>++page===1?{rows:[{seq:100,role:'user',revision:0,text:'ARCHIVE_100'}],nextBefore:50,through:100,throughAt:100}:{rows:[{seq:20,role:'user',revision:0,text:'ARCHIVE_20'}],through:300,throughAt:300}};
 const ui=new SessionScreen(new TerminalFixture(),c);ui.start();try{await ui.loadOlder();state.messages.push({agent:'pm',text:'NEW_LIVE_OUTPUT',ts:200});await ui.loadOlder();ui.tui.renderNow();assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join('\n'),/NEW_LIVE_OUTPUT/);}finally{await ui.close();}
});
