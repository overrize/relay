// Opt-in live verification: uses configured real models and consumes API allowance.
process.env.SERVER_ENABLED='false';process.env.FEISHU_APP_ID='';process.env.FEISHU_APP_SECRET='';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const repo=process.cwd();fs.mkdirSync(path.join(repo,".test-tmp"),{recursive:true});const root=fs.mkdtempSync(path.join(repo,'.test-tmp/live-round7-parallel-'));process.chdir(root);fs.writeFileSync('shared.txt','BASE');
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

const {resolveWorkspace,publishWorkspace}=await import('../dist/session/Workspaces.js');
const {fileHash}=await import('../dist/session/Tasks.js');
const provider=getAgentProviderConfig(loadConfig(),'leader'),r=createRuntimeContext(),replies=[];
const dispatch={background:'parallel real model isolation verification',constraints:['only shared.txt'],acceptance_criteria:['own variant'],stop_conditions:['agent.done'],acceptance_checks:[]};
const spawnEvent=id=>({type:'spawn',parent:'pm',child:id,role:'Worker',goal:'Write '+id+' to shared.txt',dispatch:{...dispatch,acceptance_checks:[{criterion:0,type:'file_sha256',path:'shared.txt',value:fileHash(id)}]}});
configureAgentHandlers({...r,MODEL:provider.model,DEMO:false,buildSystemPrompt:(role,id)=>`You are ${role}. **agent_id**: ${id}. Emit only compact newline-delimited JSON events with v:1,agent:${JSON.stringify(id)}. `+(role==='Worker'?`First output exactly ${JSON.stringify({v:1,type:"tool.call",agent:id,id:"write",name:"Write",args:{path:"shared.txt",content:id}})}. Wait for actual tool_result then output exactly ${JSON.stringify({v:1,type:"agent.done",agent:id,success:true,reason:"written",evidence:["shared.txt"]})}. The discriminator key must be type, never event. No other tools or messages.`:`On START emit exactly these two spawn events: ${JSON.stringify(spawnEvent('parallel-a'))} then ${JSON.stringify(spawnEvent('parallel-b'))}, with v:1,agent:pm. Then message to=user text=STARTED. Never spawn again on system inputs. On user PROGRESS reply message to=user text=PROGRESS_ACK. On system inputs reply message to=user text=ACK. No tools.`),killAgent:id=>{r.killedAgents.add(id);r.agents.get(id)?.kill();}});
const until=async f=>{const end=Date.now()+180000;while(!f()){if(Date.now()>end)throw Error('timeout: '+JSON.stringify(workItems()));await new Promise(r=>setTimeout(r,20));}};
try {ensureAgent({id:'pm',name:'PM',role:'Leader',state:'idle'});startLeaderAgent({id:'pm',firstMessage:'START',conversationMode:true,replyHook:t=>replies.push(t)});
await until(()=>workItems().length===2);r.agents.get('pm').receiveUserInput('PROGRESS?');
await until(()=>workItems().some(t=>t.status==='accepted')&&workItems().some(t=>t.status==='blocked')&&replies.includes('PROGRESS_ACK'));
const accepted=workItems().find(t=>t.status==='accepted'),blocked=workItems().find(t=>t.status==='blocked');
assert.equal(fs.readFileSync('shared.txt','utf8'),accepted.latestAgent);assert.equal(fs.readFileSync(path.join(workspacePath(blocked),'shared.txt'),'utf8'),blocked.latestAgent);assert.match(blocked.reason,/conflict/);assert.equal(blocked.attempts.length,1);
await resolveWorkspace('pm',blocked.id,'shared.txt',fileHash(accepted.latestAgent),'theirs');await publishWorkspace(workItems().find(t=>t.id===blocked.id));assert.equal(fs.readFileSync('shared.txt','utf8'),accepted.latestAgent);
fs.writeFileSync('real-verification.json',JSON.stringify({root,model:provider.model,parallelIsolated:true,accepted:accepted.latestAgent,blocked:blocked.latestAgent,conflictPreventedOverwrite:true,explicitResolution:'theirs',requests:sessionJournal().budget().used.requests,budget:sessionJournal().budget().used,continuousPM:replies.includes('PROGRESS_ACK')},null,2));console.log(fs.readFileSync('real-verification.json','utf8'));
}finally{stopTaskRecovery();for(const[id,a]of r.agents){r.killedAgents.add(id);a.kill();}for(const s of r.secretaries.values())s.destroy();r.pm.destroy();await waitTaskResolution();stopTaskRecovery();await cancelAllAgentTools();releaseRuntimeOwners();}
