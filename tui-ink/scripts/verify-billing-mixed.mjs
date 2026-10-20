// Opt-in: real official Claude subscription + configured API Worker. Credentials stay in ignored fixtures.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
process.env.SERVER_ENABLED='false';process.env.FEISHU_APP_ID='';process.env.FEISHU_APP_SECRET='';
if(!process.argv[2] || ['--codex','--copilot','--configured'].includes(process.argv[2])){
 const codex=process.argv[2]==='--codex',copilot=process.argv[2]==='--copilot',configured=process.argv[2]==='--configured';if((codex||copilot)&&!process.argv[3])throw Error('Provide an account-supported Codex model ID');
 const {loadConfig,getAgentProviderConfig}=await import('../dist/config.js');const {resolveModelRoute}=await import('../dist/models/routing.js');const userConfig=loadConfig(),worker=resolveModelRoute(userConfig,'worker','implement').candidates[0].config;
 const subscription=configured?resolveModelRoute(userConfig,'leader','pm').candidates[0].config:{provider:codex?'openai':'anthropic',model:codex||copilot?process.argv[3]:'sonnet',apiKey:'',transport:codex?'codex-cli':copilot?'copilot-sdk':'claude-cli',billing:{mode:'subscription'}};
 assert.ok(worker.apiKey,'Configure a real API Worker before running this mixed test');
 const repo=process.cwd();fs.mkdirSync(path.join(repo,'.test-tmp'),{recursive:true});const root=fs.mkdtempSync(path.join(repo,'.test-tmp/live-billing-mixed-')),configDir=path.join(root,'.spawn','config');fs.mkdirSync(configDir,{recursive:true});
 let proxy,migrationProxy,migrationBase;const rowMode=process.env.SPAWN_VERIFICATION_ROW_PRICES==='1';
 if(process.env.SPAWN_VERIFICATION_CONTRACT_PRICES==='1'){
   const http=await import('node:http'),https=await import('node:https');const upstream=new URL(worker.baseUrl??'https://api.openai.com');
   proxy=http.createServer((req,res)=>{
     const target=new URL(upstream.href);target.pathname=upstream.pathname.replace(/\/$/,'').replace(/\/v1$/,'')+req.url;
     const request=https.request(target,{method:req.method,headers:{...req.headers,host:upstream.host}},reply=>{
       void (async()=>{
         if(process.env.SPAWN_VERIFICATION_PRICE_REVISIONS==='1'&&reply.statusCode===200){
           const {SessionJournal}=await import('../dist/session/Journal.js');const {readPriceTable,trustPriceTable,revisePriceTable}=await import('../dist/session/PriceImport.js');
           const traceFile=path.join(root,'price-revisions.json'),trace=fs.existsSync(traceFile)?JSON.parse(fs.readFileSync(traceFile,'utf8')):{count:0};trace.count++;
           const j=new SessionJournal(root),pending=()=>Object.entries(j.budget().reservations).find(([,r])=>r.model===worker.model&&!r.settled);
           if(trace.count===1){
             const deadline=Date.now()+120000;while(!fs.existsSync(path.join(root,'pm-progress-marker'))){if(Date.now()>deadline)throw Error('PM progress timed out while worker was in flight');await new Promise(resolve=>setTimeout(resolve,20));}
             const [id,reservation]=pending();trace.first={id,reservation};if(rowMode)trace.sentinel=j.effectivePrices().find(p=>p.model==='same-batch-sentinel');const data=JSON.parse(fs.readFileSync(path.join(root,'contract.json'),'utf8'));data.prices=(rowMode?[data.prices[1]]:data.prices).map(p=>({...p,inputRate:3,outputRate:6}));
             const file=path.join(root,'corrected-contract.json');fs.writeFileSync(file,JSON.stringify(data));trustPriceTable(root,file,'LocalVerification');const result=await revisePriceTable(root,readPriceTable(path.join(root,'contract.json')).digest+(rowMode?':1':''),{file,reason:'live-inflight-price-correction',apply:true});trace.replacement=result.revision;assert.deepEqual(j.budget().reservations[id],reservation);
           }else if(trace.count===2){
             const [id,reservation]=pending();trace.second={id,reservation};const result=await revisePriceTable(root,readPriceTable(path.join(root,'corrected-contract.json')).digest+(rowMode?':0':''),{reason:'live-inflight-price-withdrawal',apply:true});trace.revocation=result.revision;assert.deepEqual(j.budget().reservations[id],reservation);
             if(rowMode){
               const original=JSON.parse(fs.readFileSync(path.join(root,'contract.json'),'utf8')),source=original.prices[0],file=path.join(root,'migration-contract.json');
               fs.writeFileSync(file,JSON.stringify({version:1,prices:[{...source,source:'migration-fixture',issuer:'MigratedVerification',baseUrl:migrationBase,effectiveTo:null,inputRate:5,outputRate:10}]}));trustPriceTable(root,file,'MigratedVerification');
               const migrated=await revisePriceTable(root,readPriceTable(path.join(root,'contract.json')).digest+':0',{file,reason:'live-row-endpoint-migration',migrate:true,apply:true});trace.migration=migrated.revision;
             }
           }
           fs.writeFileSync(traceFile,JSON.stringify(trace,null,2));
         }
         res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);
       })().catch(error=>{console.error('Live price revision failed:',error.message);reply.destroy();if(!res.headersSent)res.writeHead(502);res.end();});
     });
     request.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});res.on('close',()=>request.destroy());req.pipe(request);
   });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));worker.baseUrl=`http://127.0.0.1:${proxy.address().port}`;
   if(rowMode){migrationProxy=http.createServer(proxy.listeners('request')[0]);await new Promise(resolve=>migrationProxy.listen(0,'127.0.0.1',resolve));migrationBase=`http://127.0.0.1:${migrationProxy.address().port}`;}
   const {trustPriceTable,importPriceTable}=await import('../dist/session/PriceImport.js');const table=path.join(root,'contract.json');
   const entry={source:'verification-fixture',issuer:'LocalVerification',provider:worker.provider,model:worker.model,baseUrl:worker.baseUrl,currency:'USD',unit:'per-million-tokens',inputRate:1,outputRate:2,effectiveFrom:'2020-01-01T00:00:00Z',effectiveTo:'2025-01-01T00:00:00Z'};
   fs.writeFileSync(table,JSON.stringify({version:1,prices:[entry,{...entry,effectiveFrom:entry.effectiveTo,effectiveTo:null},...(rowMode?[{...entry,model:'same-batch-sentinel',effectiveTo:null}]:[])]}));trustPriceTable(root,table,'LocalVerification');await importPriceTable(root,table,{apply:true});
 }
 fs.writeFileSync(path.join(configDir,'config.json'),JSON.stringify({models:{subscription,api:{...worker,billing:process.env.SPAWN_VERIFICATION_AUTO_PRICES==='1'?{mode:'api'}:{mode:'api',inputUsdPerMillion:1,outputUsdPerMillion:1}}},agents:{leader:{model:'subscription'},worker:{model:'api'},secretary:{model:'subscription'}},routing:{profiles:{pm:['subscription'],implement:['api']},allowApiFallback:false}}),{mode:0o600});
 const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'child',root],{cwd:repo,env:{...process.env,SPAWN_CONFIG_DIR:configDir,SPAWN_SESSION_MAX_REQUESTS:'16',SPAWN_COMMUNICATION_REQUESTS:'2'},stdio:'inherit',windowsHide:true});const code=await new Promise(r=>child.on('exit',r));
 if(rowMode&&code===0){
   const cwd=process.cwd();process.chdir(root);
   try{
     const {sessionJournal}=await import('../dist/session/Journal.js'),{reserveSessionRequest,settleSessionRequest}=await import('../dist/session/Budget.js');sessionJournal().bind('migration-probe','Worker','pm','probe migrated pricing');
     const permit=reserveSessionRequest('migration-probe',1000,64,false,{...worker,baseUrl:migrationBase,billing:{mode:'api'}});
     const response=await fetch(migrationBase+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${worker.apiKey}`},body:JSON.stringify({model:worker.model,messages:[{role:'user',content:'Reply only OK.'}],max_tokens:64,stream:false}),signal:AbortSignal.timeout(120000)});
     assert.equal(response.status,200);const result=await response.json();assert.ok(result.usage?.prompt_tokens>0);settleSessionRequest('migration-probe',permit.id,result.usage.prompt_tokens,result.usage.completion_tokens);fs.writeFileSync('migration-probe.json',JSON.stringify({id:permit.id,endpoint:migrationBase,usage:result.usage}));
   }finally{process.chdir(cwd);}
 }
 for(const server of [proxy,migrationProxy])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}assert.equal(code,0);
} else {
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
const {buildCommands}=await import('../dist/tui/commands.js');

const r=createRuntimeContext(),replies=[],goal='Write result.txt exactly MIXED_OK';
const dispatch={background:'subscription PM and API Worker acceptance test',constraints:['only result.txt'],acceptance_criteria:['exact final artifact'],stop_conditions:['agent.done'],acceptance_checks:[{criterion:0,type:'file_sha256',path:'result.txt',value:(await import('node:crypto')).createHash('sha256').update('MIXED_OK').digest('hex')}]};
const event={v:1,type:'spawn',agent:'pm',parent:'pm',child:'mixed-worker',role:'Worker',goal,dispatch};
configureAgentHandlers({...r,MODEL:'fixture',DEMO:false,buildSystemPrompt:(role,id)=>`You are ${role}. Emit only newline-delimited compact JSON events with v:1,agent:${JSON.stringify(id)}. No Markdown. `+(role==='Worker'?`First emit exactly ${JSON.stringify({v:1,type:'tool.call',agent:id,id:'write',name:'Write',args:{path:'result.txt',content:'MIXED_OK'}})}. Wait for actual host tool_result then emit exactly ${JSON.stringify({v:1,type:'agent.done',agent:id,success:true,reason:'written',evidence:['result.txt']})}.`:`On initial user START emit exactly ${JSON.stringify(event)}, followed by ${JSON.stringify({v:1,type:'message',agent:id,to:'user',text:'MIXED_STARTED'})}. Never spawn on system notices. On user PROGRESS? emit exactly ${JSON.stringify({v:1,type:'message',agent:id,to:'user',text:'MIXED_PROGRESS'})}. On all other system notices reply message to=user text=MIXED_ACK. No tools. Never emit agent.done for PM; stop_conditions belongs only to the Worker.`),killAgent:id=>{r.killedAgents.add(id);r.agents.get(id)?.kill();}});
const until=async f=>{const end=Date.now()+180000;while(!f()){if(Date.now()>end)throw Error('mixed E2E timeout '+JSON.stringify(workItems()));await new Promise(r=>setTimeout(r,20));}};
try{ensureAgent({id:'pm',name:'PM',role:'Leader',state:'idle'});startLeaderAgent({id:'pm',firstMessage:'START',conversationMode:true,replyHook:t=>{replies.push(t);if(process.env.SPAWN_VERIFICATION_PRICE_REVISIONS==='1'&&t==='MIXED_PROGRESS'){assert.notEqual(workItems()[0]?.status,'accepted');fs.writeFileSync('pm-progress-marker','PM replied while Worker request was in flight');}}});await until(()=>workItems().length===1);const auditPending=process.env.SPAWN_VERIFICATION_BACKGROUND_AUDIT==='1'?(await import('../dist/session/BackgroundAudit.js')).backgroundAuditReport(root,{rebuild:true}):Promise.resolve();r.agents.get('pm').receiveUserInput('PROGRESS?');
if(process.env.SPAWN_VERIFICATION_CONTRACT_PRICES==='1'){
 const {trustPriceTable,importPriceTable}=await import('../dist/session/PriceImport.js');const history=JSON.parse(fs.readFileSync('contract.json','utf8'));history.prices=[{...history.prices[0],model:'unused-history-verification'}];fs.writeFileSync('history-while-active.json',JSON.stringify(history));trustPriceTable(root,'history-while-active.json','LocalVerification');await importPriceTable(root,'history-while-active.json',{apply:true});
}
await until(()=>workItems()[0].status==='accepted'&&replies.includes('MIXED_PROGRESS'));
await auditPending;
assert.equal(fs.readFileSync('result.txt','utf8'),'MIXED_OK');const budget=sessionJournal().budget();assert.ok(budget.byBilling.api.requests>0);const pmSubscription=getAgentProviderConfig(loadConfig(),'leader').billing?.mode==='subscription';if(pmSubscription)assert.ok(budget.byBilling.subscription.requests>0);assert.equal(budget.byBilling.subscription.microUsd,0);assert.ok(budget.byBilling.api.microUsd>0);
const statusMessages=[];const commands=buildCommands({emitCommandMessage:text=>statusMessages.push(text)});commands.find(c=>c.name==='account').handler([]);commands.find(c=>c.name==='budget').handler([]);
assert.match(statusMessages[0],/有效候选链/);assert.match(statusMessages[1],/PM 沟通预留/);assert.match(statusMessages[1],/最近调用/);if(pmSubscription)assert.match(statusMessages[1],/codex-cli|claude-cli|copilot-sdk/);assert.match(statusMessages[1],/API：/);assert.match(statusMessages[1],/订阅：/);
const accountConfig=loadConfig();for(const model of Object.values(accountConfig.models))if(model.apiKey?.length>8)assert.ok(!statusMessages.join('\n').includes(model.apiKey),'status must not expose API credentials');
const report={root,mixedTransport:pmSubscription,profileRouting:true,continuousPM:true,backgroundAudit:process.env.SPAWN_VERIFICATION_BACKGROUND_AUDIT==='1',accountStatusVerified:true,models:{pm:getAgentProviderConfig(loadConfig(),'leader').model,worker:getAgentProviderConfig(loadConfig(),'worker').model},accepted:workItems()[0].status,budget:{used:budget.used,byBilling:budget.byBilling},replies};fs.writeFileSync('verification.json',JSON.stringify(report,null,2));fs.writeFileSync('account-status.txt',statusMessages.join('\n\n'));console.log(JSON.stringify(report,null,2));
if(process.env.SPAWN_VERIFICATION_REPORT_FILE)fs.writeFileSync(process.env.SPAWN_VERIFICATION_REPORT_FILE,JSON.stringify(report,null,2));
}finally{stopTaskRecovery();for(const[id,a]of r.agents){r.killedAgents.add(id);a.kill();}for(const s of r.secretaries.values())s.destroy();r.pm.destroy();await waitTaskResolution();stopTaskRecovery();await cancelAllAgentTools();releaseRuntimeOwners();}

}
