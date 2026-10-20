// Opt-in live verification: uses configured real models and consumes API allowance.
process.env.SERVER_ENABLED='false';process.env.FEISHU_APP_ID='';process.env.FEISHU_APP_SECRET='';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
fs.mkdirSync(path.join(process.cwd(),".test-tmp"),{recursive:true});const root=fs.mkdtempSync(path.join(process.cwd(),'.test-tmp/live-round7-budget-'));process.chdir(root);process.env.SPAWN_SESSION_MAX_REQUESTS='3';process.env.SPAWN_COMMUNICATION_REQUESTS='1';
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
configureAgentHandlers({...r,MODEL:provider.model,DEMO:false,buildSystemPrompt:(role,id)=>`You are PM. Emit exactly one JSON line {"v":1,"type":"message","agent":"pm","to":"user","text":"BUDGET_PM_ACK"}. No tools, spawns, TODOs or other events.`,killAgent:id=>{r.killedAgents.add(id);r.agents.get(id)?.kill();}});
const until=async f=>{const end=Date.now()+90000;while(!f()){if(Date.now()>end)throw Error('budget E2E timeout');await new Promise(r=>setTimeout(r,20));}};
try{ensureAgent({id:'pm',name:'PM',role:'Leader',state:'idle'});startLeaderAgent({id:'pm',firstMessage:'hello',conversationMode:true,replyHook:t=>replies.push(t)});await until(()=>replies.length===1);for(let i=2;i<=3;i++){r.agents.get('pm').receiveUserInput('progress?');await until(()=>replies.length>=i);}
assert.equal(sessionJournal().budget().used.requests,3);r.agents.get('pm').receiveUserInput('progress again?');await until(()=>replies.some(t=>t.includes('预算已阻止')));assert.equal(sessionJournal().budget().used.requests,3);
fs.writeFileSync('real-verification.json',JSON.stringify({root,model:provider.model,requestLimit:3,actualManagedRequests:sessionJournal().budget().used.requests,communicationReserveUsed:true,afterExhaustionLocalReply:true,budget:sessionJournal().budget().used},null,2));console.log(fs.readFileSync('real-verification.json','utf8'));
}finally{stopTaskRecovery();for(const[id,a]of r.agents){r.killedAgents.add(id);a.kill();}for(const s of r.secretaries.values())s.destroy();r.pm.destroy();await waitTaskResolution();stopTaskRecovery();await cancelAllAgentTools();releaseRuntimeOwners();}
