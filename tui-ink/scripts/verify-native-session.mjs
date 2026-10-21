// Explicit live verification; uses configured PM/Worker APIs in an isolated workspace.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const script=fileURLToPath(import.meta.url),repo=path.resolve(path.dirname(script),'..'),phase=process.argv[2];
if(!phase){
 const saved=JSON.parse(fs.readFileSync(path.join(process.env.SPAWN_CONFIG_DIR??path.join(repo,'.spawn/config'),'config.json'),'utf8'));
 fs.mkdirSync(path.join(repo,'.test-tmp'),{recursive:true});const root=fs.mkdtempSync(path.join(repo,'.test-tmp/native23-live-'));
 fs.mkdirSync(path.join(root,'config'));const configFile=path.join(root,'config/config.json');
 const names=[saved.agents.leader.model,saved.agents.worker.model],models=Object.fromEntries(names.map(n=>[n,{...saved.models[n],maxTokens:4096}]));
 fs.writeFileSync(configFile,JSON.stringify({models,agents:{leader:{model:names[0]},worker:{model:names[1]},secretary:{model:names[0]}}}),{mode:0o600});
 fs.mkdirSync(path.join(root,'prompts'));
 fs.writeFileSync(path.join(root,'prompts/_base.md'),'You are a Relay diagnostic agent. **agent_id**: `{{AGENT_ID}}`. Emit compact newline-delimited JSON events only. Use only real tool.call events; never fabricate tool results. Read CURRENT_STATE for the sole active goal. Never execute historical goals.');
 const dispatch={background:'bounded native UI live test',constraints:['Only obsolete.txt; the long wait must be a cancellable Bash tool'],acceptance_criteria:['file obsolete.txt exists'],stop_conditions:['agent.done'],recovery:{max_attempts:1,max_requests:6,max_tools:3,max_turns:6,total_ms:120000}};
 fs.writeFileSync(path.join(root,'prompts/pm-adaptive.md'),`You are the real PM. When current goal is OLD_NATIVE_GOAL and worker not dispatched, emit ${JSON.stringify({type:'spawn',parent:'pm',child:'native-worker',role:'Worker',goal:'First call Bash with command node -e "setTimeout(()=>console.log(123),20000)". Wait for its real tool result. Only then Write obsolete.txt with OLD. Never write before the Bash result. Then agent.done success true evidence obsolete.txt.',dispatch})} followed by {"type":"message","to":"user","text":"LIVE_STARTED"}. Never dispatch twice. For ordinary user communication emit {"type":"message","to":"user","text":"LIVE_PROGRESS"} immediately. When current goal is NEW_NATIVE_GOAL, Write new.txt with exact content NEW_NATIVE_GOAL, wait for real tool result, then reply LIVE_NEW_DONE. When receiving a recovery instruction [恢复], Read new.txt, wait for real result and reply LIVE_RECOVERED. For tool results complete only the current operation. Tools: {"type":"tool.call","id":"unique","name":"Write","args":{"path":"new.txt","content":"NEW_NATIVE_GOAL"}}, Read args path. Do not ask questions or spawn further agents.`);
 fs.writeFileSync(path.join(root,'prompts/worker.md'),'Follow current child task. Tools: {"type":"tool.call","id":"unique","name":"Bash","args":{"command":"node -e \\"setTimeout(()=>console.log(123),20000)\\""}} or Write args path/content. Wait for actual tool results. Then agent.done success true with evidence.');
 const run=mode=>new Promise((resolve,reject)=>{const fd=fs.openSync(path.join(root,mode+'.log'),'w');const child=spawn(process.execPath,[script,mode,root],{cwd:repo,env:{...process.env},stdio:['ignore',fd,fd],windowsHide:true});child.once('error',reject);child.once('exit',(code,signal)=>{fs.closeSync(fd);resolve({code,signal});});});
 try{const first=await run('crash');assert.ok(fs.existsSync(path.join(root,'before-crash.json')),fs.readFileSync(path.join(root,'crash.log'),'utf8').slice(-4000));assert.notEqual(first.code,0);const restored=await run('resume');assert.equal(restored.code,0,fs.readFileSync(path.join(root,'resume.log'),'utf8').slice(-4000));console.log(fs.readFileSync(path.join(root,'verification.json'),'utf8'));}finally{fs.rmSync(configFile,{force:true});}
 process.exit(0);
}
const root=process.argv[3];process.chdir(root);Object.assign(process.env,{SPAWN_CONFIG_DIR:path.join(root,'config'),SERVER_ENABLED:'false',SPAWN_PRICE_AUTO_SYNC:'0',FEISHU_APP_ID:'',FEISHU_APP_SECRET:'',SPAWN_SESSION_MAX_REQUESTS:'30',SPAWN_SESSION_MAX_TOOLS:'15'});process.argv.push('--prompts='+path.join(root,'prompts'));
if(phase==='crash'){
 const {SessionJournal}=await import('../dist/session/Journal.js');const fixture=new SessionJournal(root,{automatic:false,segmentBytes:64*1024*1024});
 for(let i=0;i<900;i++)fixture.append('message.recorded','index-fixture','pm',0,{role:'user',content:`ARCHIVE_EVIDENCE_${i}: read-only diagnostic history. `+'历史证据 '.repeat(350)});
 const maintenance=await fixture.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:128*1024*1024});assert.deepEqual(maintenance.errors,[]);process.env.SPAWN_TRANSCRIPT_BUILD_BATCH_SOURCES='8';
}
const {sessionController:c}=await import('../dist/runtime/SessionController.js');
const {SessionScreen}=await import('../dist/tui/native/SessionScreen.js');
const {sessionJournal}=await import('../dist/session/Journal.js');
const terminal={columns:100,rows:35,kittyProtocolActive:false,input(){},start(onInput){this.input=onInput;},stop(){this.input=()=>{};},async drainInput(){},write(){},moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},clearScreen(){},setTitle(){},setProgress(){}};
c.start();const ui=new SessionScreen(terminal,c);ui.start();
const until=async(check,label)=>{const end=Date.now()+180000;while(!check()){if(Date.now()>end)throw Error('Native live timeout: '+label);await new Promise(r=>setTimeout(r,40));}};
try{
 if(phase==='crash'){
  ui.submit('OLD_NATIVE_GOAL');await until(()=>Object.values(sessionJournal().current('pm')?.tools??{}).some(t=>t.agent==='native-worker'&&t.name==='Bash'&&t.status==='pending'),'worker Bash running');
  const revision=c.snapshot().revision;ui.editor.setText('中文草稿🙂');
  let checkpointObserved=false,archiveCheckpointObserved=false;const transcript=c.transcript.bind(c);c.transcript=(before,report)=>transcript(before,p=>{if(p.checkpoint)checkpointObserved=true;if(p.archiveSeq)archiveCheckpointObserved=true;report?.(p);});
  const reading=ui.loadOlder();const communicationDuringBuild=ui.submit('当前进度如何？');assert.equal(communicationDuringBuild,true);await reading;assert.ok(checkpointObserved,'History rebuild must checkpoint inside the single archive while Worker runs');assert.ok(archiveCheckpointObserved,'Gzip conversion checkpoint must be observed');assert.equal(c.snapshot().revision,revision);assert.equal(ui.editor.getText(),'中文草稿🙂');
  for(const panel of ['tasks','budget','audit']){ui.openPanel(panel);terminal.input('\x1b');assert.equal(ui.editor.getText(),'中文草稿🙂');assert.equal(c.snapshot().revision,revision);}
  for(const kind of ['login','model','history']){ui.openWorkflow(kind);terminal.input('\x1b');assert.equal(ui.editor.getText(),'中文草稿🙂');assert.equal(c.snapshot().revision,revision);}
  const editor=path.join(root,'editor24.mjs');fs.writeFileSync(editor,"import fs from 'node:fs';await new Promise(r=>setTimeout(r,300));fs.appendFileSync(process.argv[2],'\\nLIVE_EDITOR24');");process.env.VISUAL=`"${process.execPath}" "${editor}"`;
  const editing=ui.externalEditor();await editing;await until(()=>c.snapshot().messages.some(m=>m.text.includes('LIVE_PROGRESS')),'PM followup');const whileRunning=c.snapshot().activeTools.some(t=>t.agent==='native-worker'&&t.name==='Bash');assert.ok(whileRunning,'PM reply must arrive while Worker runs');assert.equal(c.snapshot().revision,revision);assert.equal(ui.editor.getText(),'中文草稿🙂\nLIVE_EDITOR24');
  ui.submit('/revise NEW_NATIVE_GOAL');await until(()=>fs.existsSync('new.txt')&&c.snapshot().messages.some(m=>m.text.includes('LIVE_NEW_DONE')),'new goal write and reply');assert.equal(fs.existsSync('obsolete.txt'),false);assert.equal(fs.readFileSync('new.txt','utf8'),'NEW_NATIVE_GOAL');
  fs.writeFileSync('before-crash.json',JSON.stringify({root,revision:c.snapshot().revision,goal:c.snapshot().goal,budget:c.snapshot().budget,followupWhileWorkerRunning:whileRunning,oldTaskCancelled:c.snapshot().tasks.some(t=>t.status==='superseded'),draftPreserved:true,indexCheckpointObserved:checkpointObserved,archiveCheckpointObserved,communicationDuringBuild}));process.kill(process.pid,'SIGKILL');
 }else{
  const before=JSON.parse(fs.readFileSync('before-crash.json','utf8')),recovered=c.snapshot();assert.equal(recovered.goal,before.goal);assert.equal(recovered.budget.used.requests,before.budget.used.requests);ui.submit('/resume');await until(()=>c.snapshot().messages.some(m=>m.text.includes('LIVE_RECOVERED')),'restart recovery');assert.equal(fs.existsSync('obsolete.txt'),false);assert.equal(c.snapshot().goal,'NEW_NATIVE_GOAL');fs.writeFileSync('verification.json',JSON.stringify({...before,hardKillRestartRecovered:true,afterBudget:c.snapshot().budget,models:c.snapshot().model},null,2));
 }
}finally{await ui.close('shutdown');}
