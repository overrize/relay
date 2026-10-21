import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {NativeWorkflow} from '../tui/native/Workflow.js';
import {LoginFlow} from '../tui/loginFlow.js';
import {SessionScreen} from '../tui/native/SessionScreen.js';
import {rememberPrompt} from '../tui/PromptHistory.js';
import {saveModelConfig,saveAgentModel,configPath} from '../config.js';
import {stripTerminalSequences,type Terminal} from '@code-yeongyu/senpi-tui';

class TestTerminal implements Terminal{
 columns=90;rows=30;kittyProtocolActive=false;output='';stops=0;input:(s:string)=>void=()=>{};
 start(input:(s:string)=>void,_resize:()=>void){this.input=input;}stop(){this.stops++;this.input=()=>{};}async drainInput(){}write(s:string){this.output+=s;}moveBy(_n:number){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(_s:string){}setProgress(_a:boolean){}
}
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/native24-')),old=process.env.SPAWN_CONFIG_DIR;
process.env.SPAWN_CONFIG_DIR=path.join(root,'config');
after(()=>{if(old===undefined)delete process.env.SPAWN_CONFIG_DIR;else process.env.SPAWN_CONFIG_DIR=old;fs.rmSync(root,{recursive:true,force:true});});
const frame=(w:NativeWorkflow)=>stripTerminalSequences(w.render(100).join('\n'));

test('native login uses arrow selection, masked key and prepared models; cancel does not save or leak secrets',()=>{
 let saved:any[]=[];const flow=new LoginFlow((...args)=>{saved=args;}),w=new NativeWorkflow(()=>{},()=>{});w.focused=true;w.login(flow);
 w.handleInput('\x1b[B');w.handleInput('\r');assert.equal(flow.stage,'provider');w.handleInput('DeepSeek');assert.match(frame(w),/DeepSeek/);w.handleInput('\r');assert.equal(flow.stage,'key');
 w.handleInput('fixture-secret-987654');assert.ok(!w.render(100).join('').includes('fixture-secret'));assert.match(frame(w),/\*{8}/);w.handleInput('\r');assert.equal(flow.stage,'models');assert.ok(flow.catalog.models.length>0);assert.ok(!frame(w).includes('fixture-secret'));
 w.handleInput('\x1b[B');w.handleInput('\r');assert.equal(flow.stage,'target');w.handleInput('\x1b[B');w.handleInput('\r');assert.equal(flow.stage,'confirm');w.handleInput('\r');assert.equal(saved[2],'pm');assert.ok(saved[1].model);assert.equal(saved[1].apiKey,'fixture-secret-987654');
 const cancelFlow=new LoginFlow(()=>assert.fail('cancel saved')),cancel=new NativeWorkflow(()=>{},()=>{});cancel.login(cancelFlow);cancel.handleInput('\x1b');assert.equal(fs.existsSync(configPath()),false);
 w.dispose();cancel.dispose();
});

test('model workflow searches names and explicitly chooses session versus saved default and role',()=>{
 const selected:any[]=[];const open=()=>{const w=new NativeWorkflow(()=>{},()=>{});w.models([{name:'a',model:'alpha',billing:'api'},{name:'b',model:'beta',billing:'subscription'}],(...args)=>{selected.push(args);return 'ok';});return w;};
 const w=open();w.handleInput('\r');w.handleInput('beta');w.handleInput('\r');assert.match(frame(w),/保存默认/);w.handleInput('\r');assert.deepEqual(selected[0],['b','session','leader']);w.dispose();
 const other=open();other.handleInput('\x1b[B');other.handleInput('\r');other.handleInput('\r');other.handleInput('\x1b[B');other.handleInput('\r');assert.deepEqual(selected[1],['a','default','worker']);other.dispose();
 const shortcuts=open();shortcuts.handleInput('\r');shortcuts.handleInput('\x06');assert.match(frame(shortcuts),/★/);shortcuts.handleInput('\t');assert.match(frame(shortcuts),/Worker/);shortcuts.handleInput('\r');shortcuts.handleInput('\x13');assert.deepEqual(selected[2],['a','default','worker']);shortcuts.dispose();
});

test('native history searches a fresh process record and restores multiline text without sending',()=>{
 const text='跨会话测试24\n第二行🙂';const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',`import {rememberPrompt} from './src/tui/PromptHistory.ts';rememberPrompt(${JSON.stringify(text)});`],{env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 rememberPrompt('api_key=do-not-index');let restored='';const w=new NativeWorkflow(()=>{},()=>{});w.history(text=>restored=text);w.handleInput('跨会话测试24');assert.match(frame(w),/第二行/);assert.equal(restored,'');w.handleInput('\r');assert.equal(restored,text);w.dispose();
 const long='prefix '.repeat(40)+'尾部可搜索24';rememberPrompt(long);const tail=new NativeWorkflow(()=>{},()=>{});tail.history(text=>restored=text);tail.handleInput('尾部可搜索24');tail.handleInput('\r');assert.equal(restored,long);tail.dispose();
});

test('real controller model selection persists only explicit defaults and exposes no credentials',async()=>{
 saveModelConfig('a',{provider:'openai',model:'alpha',apiKey:'private-fixture'});saveModelConfig('b',{provider:'openai',model:'beta',apiKey:'private-fixture-b'});saveAgentModel('leader','a');
 const cwd=process.cwd();process.chdir(root);const {sessionController:c}=await import('../runtime/SessionController.js');c.start();const term=new TestTerminal(),screen=new SessionScreen(term,c);screen.start();
 try{
  screen.editor.setText('未发送\n中文🙂');screen.editor.handleInput('\x1b[D');const cursor=screen.editor.getCursor();term.input('\x0c');term.input('\r');term.input('\x1b[B');term.input('\r');term.input('\r');assert.equal(c.snapshot().model,'beta');assert.equal(JSON.parse(fs.readFileSync(configPath(),'utf8')).agents.leader.model,'a');assert.deepEqual(screen.editor.getCursor(),cursor);
  term.input('\x0c');term.input('\r');term.input('\r');term.input('\x1b[B');term.input('\r');assert.equal(JSON.parse(fs.readFileSync(configPath(),'utf8')).agents.leader.model,'a');assert.equal(c.snapshot().model,'alpha');assert.ok(!JSON.stringify(c.modelChoices()).includes('private-fixture'));
  term.input('\x12');term.input('\x1b');assert.equal(screen.editor.getText(),'未发送\n中文🙂');assert.deepEqual(screen.editor.getCursor(),cursor);
  screen.openWorkflow('login');term.input('\x03');assert.equal(screen.editor.getText(),'未发送\n中文🙂');assert.equal(term.stops,0);
 }finally{await screen.close();process.chdir(cwd);}
});
