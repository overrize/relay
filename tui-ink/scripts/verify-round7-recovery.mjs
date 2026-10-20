// Opt-in live verification: uses configured real models and consumes API allowance.
process.env.SERVER_ENABLED='false';process.env.FEISHU_APP_ID='';process.env.FEISHU_APP_SECRET='';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=process.cwd(),script=fileURLToPath(import.meta.url),mode=process.argv[2];
if(!mode){
 fs.mkdirSync(path.join(repo,".test-tmp"),{recursive:true});
 const root=fs.mkdtempSync(path.join(repo,'.test-tmp/live-round7-recovery-'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node --test verification.test.cjs'}}));
 fs.writeFileSync(path.join(root,'verification.test.cjs'),"const {test}=require('node:test');const assert=require('node:assert/strict');test('actual final artifact',()=>assert.equal(require('fs').readFileSync('result.txt','utf8'),'FINAL_ROUND_SEVEN'));");
 const run=phase=>new Promise((resolve,reject)=>{const log=fs.openSync(path.join(root,phase+'.log'),'w');const p=spawn(process.execPath,[script,phase,root],{cwd:repo,env:process.env,stdio:['ignore',log,log],windowsHide:true});p.on('error',reject);p.on('exit',(code,signal)=>{fs.closeSync(log);resolve({code,signal});});});
 const crash=await run('crash');assert.ok(fs.existsSync(path.join(root,'crashed.json')));assert.notEqual(crash.code,0);
 const resume=await run('resume');assert.equal(resume.code,0,fs.readFileSync(path.join(root,'resume.log'),'utf8').slice(-5000));
 console.log(fs.readFileSync(path.join(root,'real-verification.json'),'utf8'));process.exit(0);
}
const root=process.argv[3];process.chdir(root);
const {createRuntimeContext}=await import('../dist/runtime/RuntimeContext.js');
const {configureAgentHandlers,startLeaderAgent}=await import('../dist/runtime/AgentHandlers.js');
const {ensureAgent}=await import('../dist/store.js');
const {loadConfig,getAgentProviderConfig}=await import('../dist/config.js');
const {sessionJournal}=await import('../dist/session/Journal.js');
const {workItems}=await import('../dist/session/Tasks.js');
const {workspacePath}=await import('../dist/session/Workspaces.js');
const {stopTaskRecovery,waitTaskResolution}=await import('../dist/runtime/TaskRecovery.js');
const {releaseRuntimeOwners}=await import('../dist/session/RuntimeOwner.js');
const {executeTool}=await import('../dist/tools/registry.js');
const {cancelAllAgentTools}=await import('../dist/tools/command.js');
const provider=getAgentProviderConfig(loadConfig(),'leader'),r=createRuntimeContext(),replies=[];
const dispatch={background:'第七轮真实模型隔离与重启故障注入测试',constraints:['只操作 result.txt'],acceptance_criteria:['文件内容为 FINAL_ROUND_SEVEN','独立测试通过'],stop_conditions:['agent.done'],worker_profile:'implement',recovery:{max_attempts:2,max_turns:15,max_requests:20,max_tools:10,total_ms:300000},acceptance_checks:[{criterion:0,type:'file_sha256',path:'result.txt',value:(await import('node:crypto')).createHash('sha256').update('FINAL_ROUND_SEVEN').digest('hex')},{criterion:1,type:'test_suite',path:'.'}]};
const goal='在 result.txt 中完成 FINAL_ROUND_SEVEN，并通过文件验收。';
configureAgentHandlers({...r,MODEL:provider.model,DEMO:false,buildSystemPrompt:(role,id)=>`You are ${role}. **agent_id**: \`${id}\`. Emit only newline-delimited compact JSON events. All events have v:1 and agent:${JSON.stringify(id)}. Tools: {"type":"tool.call","id":"unique","name":"Write","args":{"path":"result.txt","content":"text"}}; Read {"path":"result.txt"}; Edit {"path":"result.txt","old_string":"text","new_string":"text"}. Wait for actual tool_result before next step. Done {"type":"agent.done","success":true,"reason":"verified","evidence":["file"]}. Do not use TODO for this small fixture. `+(role==='Worker'?(id==='real-worker'?`This is deliberate crash/recovery fault injection. First Write result.txt content exactly PARTIAL_ROUND_SEVEN. After the tool result STOP using {"type":"agent.done","success":false,"reason":"retryable: complete FINAL in the next attempt"}. Do not write FINAL in this attempt. No messages to PM or user.`:`You are the recovery attempt. First repeat exactly Write result.txt content PARTIAL_ROUND_SEVEN once to test the runtime receipt deduplication guard. After its result, Read result.txt, then Edit old_string PARTIAL_ROUND_SEVEN to new_string FINAL_ROUND_SEVEN, then agent.done success true after actual Edit result. No messages to user.`):`You are a continuing PM. On LIVE_START only emit {"type":"spawn","parent":"pm","child":"real-worker","role":"Worker","goal":${JSON.stringify(goal)},"dispatch":${JSON.stringify(dispatch)}} followed by {"type":"message","to":"user","text":"LIVE_SEVEN_STARTED"}. Never spawn on system notifications or recovery. For a user followup LIVE_PROGRESS reply {"type":"message","to":"user","text":"LIVE_SEVEN_PROGRESS"}; for other system/recovery inputs reply {"type":"message","to":"user","text":"LIVE_SEVEN_ACK"}. The controller handles retries and checks. Stay responsive. No tools.`),killAgent:id=>{r.killedAgents.add(id);r.agents.get(id)?.kill();}});
const until=async f=>{const end=Date.now()+180000;while(!f()){if(Date.now()>end)throw Error('real round7 E2E timeout');await new Promise(r=>setTimeout(r,20));}};
try{
 ensureAgent({id:'pm',name:'PM',role:'Leader',state:'idle'});
 startLeaderAgent({id:'pm',...(mode==='crash'?{firstMessage:'LIVE_START'}:{resumedMemoryId:'pm'}),conversationMode:true,replyHook:t=>replies.push(t)});
 if(mode==='crash'){
  await until(()=>workItems()[0]?.status==='retry_wait');
  const t=workItems()[0];assert.equal(t.attempts.length,1);assert.equal(fs.readFileSync(path.join(workspacePath(t),'result.txt'),'utf8'),'PARTIAL_ROUND_SEVEN');
  fs.writeFileSync('crashed.json',JSON.stringify({task:t.id,attempts:t.attempts,usedTools:t.usedTools,usedRequests:t.usedRequests,nextAt:t.nextAt}));process.kill(process.pid,'SIGKILL');
 }else{
  await until(()=>r.agents.has('real-worker-retry-2'));
  const followupWhileRunning=workItems()[0].status==='running';r.agents.get('pm').receiveUserInput('LIVE_PROGRESS?');
  await until(()=>workItems()[0]?.status==='accepted'&&replies.includes('LIVE_SEVEN_PROGRESS'));
  const t=workItems()[0],before=JSON.parse(fs.readFileSync('crashed.json','utf8'));
  assert.deepEqual(t.attempts,['real-worker','real-worker-retry-2']);assert.equal(t.usedTools,3);assert.equal(fs.readFileSync('result.txt','utf8'),'FINAL_ROUND_SEVEN');
  assert.equal(t.verdict.reviewer,'runtime-file-checks');assert.equal(sessionJournal().currentRevision('pm'),1);
  const history=await sessionJournal().search('pm','Verified completed operation');assert.ok(history.length);
  const status=await executeTool('TaskStatus',{agent:'real-worker-retry-2'},{agentId:'pm'});assert.match(status.output,/accepted/);
  const report={root,model:provider.model,sessionBudget:sessionJournal().budget().used,isolatedWorkspace:true,hardKillThenRestart:true,taskId:t.id,attempts:t.attempts,budgetBeforeCrash:before,budgetAfterRestart:{turns:t.usedTurns,requests:t.usedRequests,tools:t.usedTools},verifiedWriteReused:true,finalContentVerified:true,independentAcceptance:t.verdict,followupWhileRunning,replies};
  fs.writeFileSync('real-verification.json',JSON.stringify(report,null,2));
 }
}finally{stopTaskRecovery();for(const [id,a] of r.agents){r.killedAgents.add(id);a.kill();}for(const s of r.secretaries.values())s.destroy();r.pm.destroy();await waitTaskResolution();stopTaskRecovery();await cancelAllAgentTools();releaseRuntimeOwners();}
