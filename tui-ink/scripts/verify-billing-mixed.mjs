// Opt-in: real official Claude subscription + configured API Worker. Credentials stay in ignored fixtures.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
process.env.SERVER_ENABLED='false';process.env.FEISHU_APP_ID='';process.env.FEISHU_APP_SECRET='';
if(!process.argv[2] || process.argv[2]==='--codex'){
 const codex=process.argv[2]==='--codex';if(codex&&!process.argv[3])throw Error('Provide an account-supported Codex model ID');
 const subscription={provider:codex?'openai':'anthropic',model:codex?process.argv[3]:'sonnet',apiKey:'',transport:codex?'codex-cli':'claude-cli',billing:{mode:'subscription'}};
 const {loadConfig,getAgentProviderConfig}=await import('../dist/config.js');const worker=getAgentProviderConfig(loadConfig(),'worker');
 assert.ok(worker.apiKey,'Configure a real API Worker before running this mixed test');
 const repo=process.cwd();fs.mkdirSync(path.join(repo,'.test-tmp'),{recursive:true});const root=fs.mkdtempSync(path.join(repo,'.test-tmp/live-billing-mixed-')),configDir=path.join(root,'.spawn','config');fs.mkdirSync(configDir,{recursive:true});
 fs.writeFileSync(path.join(configDir,'config.json'),JSON.stringify({models:{subscription,api:{...worker,billing:{mode:'api',inputUsdPerMillion:1,outputUsdPerMillion:1}}},agents:{leader:{model:'subscription'},worker:{model:'api'},secretary:{model:'subscription'}},routing:{profiles:{pm:['subscription'],implement:['api']},allowApiFallback:false}}),{mode:0o600});
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'child',root],{cwd:repo,env:{...process.env,SPAWN_CONFIG_DIR:configDir,SPAWN_SESSION_MAX_REQUESTS:'16',SPAWN_COMMUNICATION_REQUESTS:'2'},stdio:'inherit',windowsHide:true});const code=await new Promise(r=>child.on('exit',r));assert.equal(code,0);process.exit(0);
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

const r=createRuntimeContext(),replies=[],goal='Write result.txt exactly MIXED_OK';
const dispatch={background:'subscription PM and API Worker acceptance test',constraints:['only result.txt'],acceptance_criteria:['exact final artifact'],stop_conditions:['agent.done'],acceptance_checks:[{criterion:0,type:'file_sha256',path:'result.txt',value:(await import('node:crypto')).createHash('sha256').update('MIXED_OK').digest('hex')}]};
const event={v:1,type:'spawn',agent:'pm',parent:'pm',child:'mixed-worker',role:'Worker',goal,dispatch};
configureAgentHandlers({...r,MODEL:'fixture',DEMO:false,buildSystemPrompt:(role,id)=>`You are ${role}. Emit only newline-delimited compact JSON events with v:1,agent:${JSON.stringify(id)}. No Markdown. `+(role==='Worker'?`First emit exactly ${JSON.stringify({v:1,type:'tool.call',agent:id,id:'write',name:'Write',args:{path:'result.txt',content:'MIXED_OK'}})}. Wait for actual host tool_result then emit exactly ${JSON.stringify({v:1,type:'agent.done',agent:id,success:true,reason:'written',evidence:['result.txt']})}.`:`On initial user START emit exactly ${JSON.stringify(event)}, followed by ${JSON.stringify({v:1,type:'message',agent:id,to:'user',text:'MIXED_STARTED'})}. Never spawn on system notices. On user PROGRESS? emit exactly ${JSON.stringify({v:1,type:'message',agent:id,to:'user',text:'MIXED_PROGRESS'})}. On all other system notices reply message to=user text=MIXED_ACK. No tools.`),killAgent:id=>{r.killedAgents.add(id);r.agents.get(id)?.kill();}});
const until=async f=>{const end=Date.now()+180000;while(!f()){if(Date.now()>end)throw Error('mixed E2E timeout '+JSON.stringify(workItems()));await new Promise(r=>setTimeout(r,20));}};
try{ensureAgent({id:'pm',name:'PM',role:'Leader',state:'idle'});startLeaderAgent({id:'pm',firstMessage:'START',conversationMode:true,replyHook:t=>replies.push(t)});await until(()=>workItems().length===1);r.agents.get('pm').receiveUserInput('PROGRESS?');await until(()=>workItems()[0].status==='accepted'&&replies.includes('MIXED_PROGRESS'));
assert.equal(fs.readFileSync('result.txt','utf8'),'MIXED_OK');const budget=sessionJournal().budget();assert.ok(budget.byBilling.api.requests>0);assert.ok(budget.byBilling.subscription.requests>0);assert.equal(budget.byBilling.subscription.microUsd,0);assert.ok(budget.byBilling.api.microUsd>0);
const report={root,mixedTransport:true,profileRouting:true,continuousPM:true,accepted:workItems()[0].status,budget:{used:budget.used,byBilling:budget.byBilling},replies};fs.writeFileSync('verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{stopTaskRecovery();for(const[id,a]of r.agents){r.killedAgents.add(id);a.kill();}for(const s of r.secretaries.values())s.destroy();r.pm.destroy();await waitTaskResolution();stopTaskRecovery();await cancelAllAgentTools();releaseRuntimeOwners();}
