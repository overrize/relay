import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {SessionScreen} from '../tui/native/SessionScreen.js';
import type {Terminal} from '@code-yeongyu/senpi-tui';
const exec=promisify(execFile);
class VirtualTerminal implements Terminal{
 columns=90;rows=30;kittyProtocolActive=false;output='';input:(s:string)=>void=()=>{};
 start(input:(s:string)=>void,_resize:()=>void){this.input=input;}stop(){this.input=()=>{};}async drainInput(){}write(s:string){this.output+=s;}moveBy(_n:number){}hideCursor(){}showCursor(){}clearLine(){}clearFromCursor(){}clearScreen(){}setTitle(_s:string){}setProgress(_a:boolean){}
}
test('native UI drives the shared real PM/Worker runtime: communicate, detach, revise, cancel stale tools and restart',async()=>{
 const original=process.cwd(),env={...process.env},controllerUrl=pathToFileURL(path.resolve('src/runtime/SessionController.ts')).href,tsx=pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,screenUrl=pathToFileURL(path.resolve('src/tui/native/SessionScreen.ts')).href;
 fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/controller23-'));process.chdir(root);process.env.SPAWN_CONFIG_DIR=path.join(root,'config');process.env.SERVER_PORT='0';process.env.SPAWN_PRICE_AUTO_SYNC='0';process.env.SPAWN_WORKSPACE_ISOLATION='shared';
 let workerSeen=false,workerClosed=false,phase='first',newWritten=false,recoveryWritten=false;const calls:{id:string;body:any}[]=[];
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),system=body.messages.find((m:any)=>m.role==='system')?.content??'',id=/agent_id\*\*: `([^`]+)`/.exec(system)?.[1]??'pm';calls.push({id,body});
  const send=(events:any[])=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:events.map(e=>JSON.stringify(e)).join('\n')}}],usage:{prompt_tokens:30,completion_tokens:15}})}\n\ndata: [DONE]\n\n`);};
  if(id==='old-worker'){workerSeen=true;res.on('close',()=>workerClosed=true);const delayed=setTimeout(()=>{if(!res.destroyed)send([{type:'tool.call',id:'obsolete',name:'Write',args:{path:'obsolete.txt',content:'OLD'}}]);},60000);delayed.unref();res.once('close',()=>clearTimeout(delayed));return;}
  if(phase==='recover'){
   assert.match(system,/当前唯一有效目标：NEW_GOAL/);
   if(!recoveryWritten){recoveryWritten=true;send([{type:'tool.call',id:'restored',name:'Write',args:{path:'resumed.txt',content:'NEW_GOAL'}}]);}
   else send([{type:'message',to:'user',text:'RESUMED_OK'}]);return;
  }
  if(system.includes('当前唯一有效目标：NEW_GOAL')){
   if(!newWritten){newWritten=true;send([{type:'tool.call',id:'new-write',name:'Write',args:{path:'new.txt',content:'NEW_GOAL'}}]);}
   else send([{type:'message',to:'user',text:'NEW_DONE'}]);return;
  }
  if(calls.filter(c=>c.id==='pm').length===1)send([{type:'spawn',parent:'pm',child:'old-worker',role:'Worker',goal:'obsolete delayed work',dispatch:{background:'test',constraints:[],acceptance_criteria:['file'],stop_conditions:['agent.done']}},{type:'message',to:'user',text:'STARTED'}]);
  else send([{type:'spawn',parent:'pm',child:'must-not-spawn-from-query',role:'Worker',goal:'not authorized',dispatch:{background:'test',constraints:[],acceptance_criteria:['file'],stop_conditions:['agent.done']}},{type:'message',to:'user',text:'PM_STILL_RESPONSIVE'}]);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!,{recursive:true});fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!,'config.json'),JSON.stringify({models:{mock:{provider:'openai',model:'fixture',apiKey:'local-only',baseUrl:`http://127.0.0.1:${(server.address() as any).port}`}},agents:{leader:{model:'mock'},worker:{model:'mock'},secretary:{model:'mock'}}}));
 const {sessionController:c}=await import('../runtime/SessionController.js');c.start({http:true});const terminal=new VirtualTerminal();let ui=new SessionScreen(terminal,c);ui.start();
 const until=async(f:()=>boolean)=>{const end=Date.now()+(process.env.CI?45000:15000);while(!f()){assert.ok(Date.now()<end,'controller flow timeout');await new Promise(r=>setTimeout(r,15));}};
 try{
  c.interrupt();assert.equal(c.snapshot().goal,'');assert.ok(ui.submit('OLD_GOAL'));await until(()=>workerSeen);const revision=c.snapshot().revision;ui.editor.setText('未发送草稿🙂');
  ui.openWorkflow('login');assert.ok(ui.submit('这是补充背景，不是新目标'));await until(()=>c.snapshot().messages.some(m=>m.text==='PM_STILL_RESPONSIVE'));terminal.input('\x1b');assert.equal(c.snapshot().revision,revision);assert.ok(!c.snapshot().agents.some(a=>a.id==='must-not-spawn-from-query'));assert.equal(ui.editor.getText(),'未发送草稿🙂');
  const editorFixture=path.join(root,'editor-fixture.mjs');fs.writeFileSync(editorFixture,"import fs from 'node:fs';await new Promise(r=>setTimeout(r,150));fs.appendFileSync(process.argv[2],'\\n外部编辑器返回');");process.env.VISUAL=`\"${process.execPath}\" \"${editorFixture}\"`;
  const editing=ui.externalEditor();assert.ok(c.snapshot().agents.some(a=>a.id==='old-worker'));c.send('编辑器运行期间追问');await editing;assert.equal(ui.editor.getText(),'未发送草稿🙂\n外部编辑器返回');assert.equal(workerClosed,false);assert.equal(c.snapshot().revision,revision);
  process.env.VISUAL=`\"${process.execPath}\" -e \"process.exit(1)\"`;const draft=ui.editor.getText();await ui.externalEditor();assert.equal(ui.editor.getText(),draft);assert.ok(fs.readdirSync(path.join(root,'.spawn','editor-drafts')).length>0);
  c.send('相同输入的可靠重传',{inputId:'dedup-query'});c.send('相同输入的可靠重传',{inputId:'dedup-query'});await until(()=>c.snapshot().inputs.some(i=>i.id==='dedup-query'&&i.status==='done'));const callsBefore=calls.length;c.send('相同输入的可靠重传',{inputId:'dedup-query'});await new Promise(r=>setTimeout(r,40));assert.equal(calls.length,callsBefore);assert.equal(c.snapshot().inputs.filter(i=>i.id==='dedup-query').length,1);
  await ui.close('detach');assert.ok(c.snapshot().agents.some(a=>a.id==='old-worker'));ui=new SessionScreen(new VirtualTerminal(),c);ui.start();
  assert.ok(ui.submit('/revise NEW_GOAL'));await until(()=>fs.existsSync('new.txt'));await until(()=>c.snapshot().messages.some(m=>m.text==='NEW_DONE'));await until(()=>workerClosed);assert.equal(fs.existsSync('obsolete.txt'),false);assert.equal(c.snapshot().goal,'NEW_GOAL');assert.ok(c.snapshot().tasks.some(t=>t.status==='superseded'));assert.ok(c.snapshot().revision>revision);
  assert.ok(!JSON.stringify(c.snapshot()).includes('local-only'));assert.throws(()=>c.resume(),/会话已连接/);const copy=c.snapshot();copy.goal='tampered';assert.equal(c.snapshot().goal,'NEW_GOAL');ui.submit('/interrupt');assert.equal(c.snapshot().goal,'NEW_GOAL');
  const before=c.snapshot().budget;await ui.close('shutdown');phase='recover';
  const source=`import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='react'||specifier==='ink')throw Error('LEGACY_UI_IMPORTED');return next(specifier,context);}});await import(${JSON.stringify(screenUrl)});const {sessionController:c}=await import(${JSON.stringify(controllerUrl)});c.start();const before=c.snapshot();c.resume();const until=Date.now()+45000;while(!c.snapshot().messages.some(m=>m.text==='RESUMED_OK')){if(Date.now()>until)throw Error('resume timeout');await new Promise(r=>setTimeout(r,20));}console.log(JSON.stringify({goal:c.snapshot().goal,revision:c.snapshot().revision,before:before.budget,after:c.snapshot().budget}));await c.shutdown();`;
  const child=await exec(process.execPath,['--import',tsx,'--input-type=module','-e',source],{cwd:root,env:{...process.env,SERVER_ENABLED:'false'},timeout:60000,maxBuffer:1024*1024});const report=JSON.parse(child.stdout.trim().split('\n').at(-1)!);assert.equal(report.goal,'NEW_GOAL');assert.equal(fs.readFileSync('resumed.txt','utf8'),'NEW_GOAL');assert.equal(report.before.used.requests,(before as any).used.requests);assert.ok(report.after.used.requests>report.before.used.requests);assert.equal(fs.existsSync('obsolete.txt'),false);
 }finally{await ui.close('shutdown');await c.shutdown();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));process.chdir(original);process.env={...env};fs.rmSync(root,{recursive:true,force:true});}
});
