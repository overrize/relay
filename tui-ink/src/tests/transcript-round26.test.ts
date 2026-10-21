import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SessionJournal} from '../session/Journal.js';
import {transcriptPage} from '../session/Transcript.js';
import {VirtualTranscript} from '../tui/native/VirtualTranscript.js';
import {SessionScreen} from '../tui/native/SessionScreen.js';
import {stripTerminalSequences,type Terminal} from '@code-yeongyu/senpi-tui';
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/transcript26-'));
after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('persistent sequence index pages without replay, appends incrementally, survives compaction and rebuilds lost or corrupt caches',async()=>{
 const j=new SessionJournal(root,{automatic:false,segmentBytes:4096});j.bind('pm','Leader');for(let i=0;i<200;i++)j.append('message.recorded','pm','pm',0,{role:'user',content:`INDEX_${i} `+'档案🙂 '.repeat(80)});
 const first=await transcriptPage(root,undefined,30);assert.equal(first.index?.mode,'rebuilt');assert.ok(first.index!.visited>200);assert.equal(first.rows.at(-1)?.text.startsWith('INDEX_199 '),true);
 const second=await transcriptPage(root,first.nextBefore,30);assert.equal(second.index?.visited,0);assert.equal(second.index?.mode,'incremental');assert.equal(new Set([...first.rows,...second.rows].map(r=>r.seq)).size,60);
 j.append('message.recorded','pm','pm',0,{role:'user',content:'APPENDED'});const appended=await transcriptPage(root);assert.equal(appended.index?.visited,1);assert.equal(appended.rows.at(-1)?.text,'APPENDED');
 const current=j.current('pm');const report=await j.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:64*1024*1024});assert.ok(report.compactedSegments>0);assert.deepEqual(report.errors,[]);assert.deepEqual(new SessionJournal(root).current('pm'),current);
 const retained=await transcriptPage(root);assert.equal(retained.rows.at(-1)?.text,'APPENDED');const warm=await transcriptPage(root,retained.nextBefore);assert.equal(warm.index?.visited,0);assert.equal(warm.index?.projectionBytesRead,0);
 const file=path.join(root,'.spawn/transcript-cache/index.sqlite');fs.unlinkSync(file);const rebuilt=await transcriptPage(root);assert.equal(rebuilt.index?.mode,'rebuilt');assert.deepEqual(rebuilt.rows,retained.rows);
 const db=new DatabaseSync(file);db.exec("UPDATE messages SET json='corrupt' WHERE seq=(SELECT max(seq) FROM messages)");db.close();const repaired=await transcriptPage(root);assert.equal(repaired.index?.mode,'rebuilt');assert.deepEqual(repaired.rows,retained.rows);
 const removed=new DatabaseSync(file);removed.exec('DELETE FROM messages WHERE seq=(SELECT max(seq) FROM messages)');removed.close();const restoredRow=await transcriptPage(root);assert.equal(restoredRow.index?.mode,'rebuilt');assert.deepEqual(restoredRow.rows,retained.rows);
 const archive=path.join(root,'.spawn/events/memory',fs.readdirSync(path.join(root,'.spawn/events/memory')).find(n=>n.endsWith('.mem.gz'))!);const bytes=fs.readFileSync(archive),damaged=Buffer.from(bytes);damaged[0]^=1;fs.writeFileSync(archive,damaged);await assert.rejects(transcriptPage(root),/校验/);fs.writeFileSync(archive,bytes);assert.equal((await transcriptPage(root)).rows.at(-1)?.text,'APPENDED');
 const quota=process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES;process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES='0';try{const unretained=await transcriptPage(root);assert.equal(unretained.index?.retained,false);assert.equal(unretained.rows.at(-1)?.text,'APPENDED');const empty=new DatabaseSync(file);assert.equal((empty.prepare('SELECT count(*) AS n FROM messages').get() as any).n,0);empty.close();}finally{if(quota===undefined)delete process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES;else process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES=quota;}
});

test('virtual transcript wraps only new blocks, renders a bounded viewport and supports wheel plus width changes',()=>{
 let height=18;const view=new VirtualTranscript(()=>height,()=>{}),texts=Array.from({length:10000},(_,i)=>`MESSAGE_${i} 中文🙂\nsecond line`);view.setBlocks(texts);assert.equal(view.render(80).length,18);const measured=view.stats.measuredBlocks;
 for(let i=0;i<100;i++)view.render(80);assert.equal(view.stats.measuredBlocks,measured);assert.ok(view.stats.cachedBlocks<=24);assert.ok(view.stats.visibleLines<=18);
 const initial=view.scrollTop;view.handleMouse({type:'wheel',wheelDelta:-12} as any);assert.ok(view.scrollTop<initial);const top=view.scrollTop;view.setBlocks([...texts,'LIVE_APPENDED']);view.render(80);assert.equal(view.scrollTop,top);assert.equal(view.stats.measuredBlocks,measured+1);
 view.scrollToStart();assert.match(view.render(80).join('\n'),/MESSAGE_0/);view.scrollToEnd();assert.match(view.render(80).join('\n'),/LIVE_APPENDED/);
 height=9;assert.equal(view.render(40).length,9);const reflow=view.stats.measuredBlocks;view.render(40);assert.equal(view.stats.measuredBlocks,reflow);assert.ok(view.stats.cachedBlocks<=24);
});

class TerminalFixture implements Terminal{
 columns=90;rows=24;kittyProtocolActive=false;input:(s:string)=>void=()=>{};
 start(input:(s:string)=>void,_resize:()=>void){this.input=input;}stop(){this.input=()=>{};}async drainInput(){}write(_s:string){}moveBy(_n:number){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(_s:string){}setProgress(_a:boolean){}
}
test('UI unloads excess historical pages, preserves drafts and supports returning to latest while cancelling stale page delivery',async()=>{
 const state:any={revision:1,goal:'CURRENT',agents:[],inputs:[],messages:[{agent:'pm',text:'LATEST_REALTIME',ts:200}],history:[],tasks:[],budget:{note:'none'},recoverable:false,model:'fixture'};let cursor=2000,rows=0;
 const c:any={snapshot:()=>structuredClone(state),subscribe:(f:any)=>{f(state);return()=>{};},shutdown:async()=>{},transcript:async()=>{const page=Array.from({length:80},()=>({seq:cursor--,role:'user',revision:0,text:`HISTORY_${++rows}`})).reverse();return {rows:page,nextBefore:cursor,through:2000,throughAt:100};}};
 const term=new TerminalFixture(),ui=new SessionScreen(term,c);ui.start();ui.editor.setText('未发送草稿🙂');
 try{for(let i=0;i<16;i++)await ui.loadOlder();assert.ok((ui as any).archiveRows.length<=1024);assert.ok(ui.viewport.stats.cachedBlocks<=24);assert.equal(ui.editor.getText(),'未发送草稿🙂');
  const top=ui.viewport.scrollTop;term.input('\x1b[<65;8;5M');ui.tui.renderNow();assert.ok(ui.viewport.scrollTop>top,'toolkit mouse dispatch must reach the virtual component');
  ui.submit('/latest');ui.tui.renderNow();assert.equal((ui as any).archiveRows.length,0);assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join('\n'),/LATEST_REALTIME/);assert.equal(ui.editor.getText(),'未发送草稿🙂');
  let release:(p:any)=>void=()=>{};c.transcript=()=>new Promise(r=>release=r);const pending=ui.loadOlder();ui.latest();release({rows:[{seq:1,role:'user',revision:0,text:'STALE_PAGE'}],through:1,throughAt:0});await pending;ui.tui.renderNow();assert.ok(!ui.tui.getScreenLines().join('').includes('STALE_PAGE'));
 }finally{await ui.close();}
});
