import {parseAgentOutput} from "../protocol/normalizer.js";
import {validateCodexHostProtocol} from "../adapters/codexBudget.js";
import http from "node:http";
import {HttpConvAgent} from "../adapters/httpAgent.js";
import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {parseUsage,refreshUsage,cachedUsage,usageExhausted,UsageError,type UsageSnapshot} from "../subscriptions/usage.js";
import {codexAllocation,codexOutputGuard,codexOutputSchema,codexInputBound} from "../adapters/codexBudget.js";
import {callCodexSubscription} from "../adapters/codexSubscription.js";
import {parseCopilotResult} from "../adapters/copilotSubscription.js";
import {runCopilot,copilotExecutable} from "../subscriptions/copilotBridge.js";
import {copilotEnvironment} from "../subscriptions/usageProviders.js";
import {resolveModelConfigInput,loadConfig} from "../config.js";
import {resolveModelRoute,routeCanFallback} from "../models/routing.js";
import {execCommand} from "../tools/command.js";
import {sessionJournal} from "../session/Journal.js";
import {reserveSessionRequest,settleSessionRequest} from "../session/Budget.js";
import {buildCommands} from "../tui/commands.js";

const original=process.cwd(),env={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-round9-"));
beforeEach(()=>{const root=fs.mkdtempSync(path.join(scratch,"case-"));process.chdir(root);process.env.SPAWN_USAGE_CACHE_DIR=path.join(root,"usage");process.env.SPAWN_SESSION_MAX_REQUESTS="5";process.env.SPAWN_COMMUNICATION_REQUESTS="1";});
afterEach(()=>{process.chdir(original);process.env={...env};});

test("Claude quota parses current and legacy windows without inventing absent balances",()=>{
  assert.deepEqual(parseUsage("claude",{}),[]);assert.equal(parseUsage("claude",{five_hour:{utilization:0}})[0]!.remainingPercent,100);
  const rows=parseUsage("claude",{limits:[{kind:"session",percent:100,resets_at:"2030-01-01T00:00:00Z"},{kind:"weekly_all",percent:34}]});assert.equal(rows[0]!.remainingPercent,0);assert.equal(rows[1]!.remainingPercent,66);
  assert.deepEqual(parseUsage("claude",{limits:[{percent:Infinity},{percent:-1},{percent:101}]}),[]);
});
test("Codex quotas preserve independent buckets and seconds-based reset times",()=>{
  const rows=parseUsage("codex",{rateLimitsByLimitId:{codex:{primary:{usedPercent:10,resetsAt:2000000000}},other:{secondary:{usedPercent:100}}}});assert.equal(rows.length,2);assert.equal(rows[0]!.resetsAt,2000000000000);
  const snapshot:UsageSnapshot={provider:"codex",state:"fresh",windows:rows,checkedAt:100,observedAt:100};assert.equal(usageExhausted(snapshot,100),false);
});
test("Copilot unlimited entitlement is distinct from zero and missing quota",()=>{
  const rows=parseUsage("copilot",{quotaSnapshots:{chat:{isUnlimitedEntitlement:true,remainingPercentage:0},premium_interactions:{remainingPercentage:25,entitlementRequests:100,usedRequests:75,resetDate:"2030-01-01"}}});
  assert.equal(rows[0]!.unlimited,true);assert.equal(rows[1]!.remaining,25);assert.equal(rows[1]!.remainingPercent,25);assert.deepEqual(parseUsage("copilot",{}),[]);
});
test("expired or stale exhaustion never blocks; fresh zero blocks even when reset is unknown",()=>{
  const snapshot:UsageSnapshot={provider:"claude",state:"fresh",checkedAt:1000,observedAt:1000,windows:[{label:"5h",remainingPercent:0}]};assert.equal(usageExhausted(snapshot,1000),true);assert.equal(usageExhausted(snapshot,100000),false);assert.equal(usageExhausted({...snapshot,state:"stale"},1000),false);assert.equal(usageExhausted({...snapshot,windows:[{label:"5h",remainingPercent:0,resetsAt:999}]},1000),false);
});
test("concurrent refreshes coalesce; normal reads and force refreshes respect minimum cache age",async()=>{
  let calls=0,now=100000;const fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return [{label:"5h",remainingPercent:90}];};
  const options={now:()=>now,identity:"fixture",fetch};await Promise.all(Array.from({length:5},()=>refreshUsage("claude",options)));assert.equal(calls,1);
  await refreshUsage("claude",{...options,force:true});assert.equal(calls,1);now+=6000;await refreshUsage("claude",{...options,force:true});assert.equal(calls,2);
});
test("429 backoff survives another caller and preserves last good data as stale",async()=>{
  let now=100000,calls=0;const options={identity:"fixture",now:()=>now,force:true};await refreshUsage("claude",{...options,fetch:async()=>[{label:"5h",remainingPercent:80}]});now+=6000;
  const failed=await refreshUsage("claude",{...options,fetch:async()=>{calls++;throw new UsageError("rate-limited",120000);}});assert.equal(failed.state,"stale");assert.equal(failed.windows[0]!.remainingPercent,80);
  now+=10000;await refreshUsage("claude",{...options,fetch:async()=>{calls++;return [];}});assert.equal(calls,1);
});
test("bad response and missing credentials remain unknown/error rather than zero",async()=>{
  const unknown=await refreshUsage("codex",{identity:"x",fetch:async()=>[]});assert.equal(unknown.state,"unknown");assert.equal(unknown.windows.length,0);
  const failed=await refreshUsage("copilot",{fetch:async()=>{throw new Error("secret account text");}});assert.equal(failed.errorCode,"usage-unavailable");assert.equal(JSON.stringify(failed).includes("secret"),false);assert.equal(usageExhausted(failed),false);
});
test("cache isolates providers and account identities without retaining credentials",async()=>{
  await refreshUsage("claude",{identity:"account-a",fetch:async()=>[{label:"5h",remainingPercent:20}]});const second=await refreshUsage("claude",{identity:"account-b",fetch:async()=>[{label:"5h",remainingPercent:60}]});assert.equal(second.windows[0]!.remainingPercent,60);
  assert.equal(cachedUsage("codex").state,"unknown");assert.equal(fs.readdirSync(process.env.SPAWN_USAGE_CACHE_DIR!).filter(f=>f.endsWith('.json')).length,2);
});
test("Codex schema and incremental guard enforce bounded output and reject extra work",()=>{
  const allocation=codexAllocation(128,20000);assert.equal(codexOutputSchema(allocation).properties.output.maxLength,128);
  const guard=codexOutputGuard(allocation);guard(Buffer.from('{"type":"turn.started"}\n'));assert.throws(()=>guard(Buffer.from('{"type":"turn.started"}\n')),/extra Codex turn/);
  assert.throws(()=>codexOutputGuard(allocation)(Buffer.from('{"type":"item.started","item":{"type":"command_execution"}}\n')),/nested Codex tool/);
  assert.throws(()=>codexOutputGuard(allocation)(Buffer.alloc(allocation.maxWireBytes+1)),/wire output/);
});
test("Codex guard carries exact reported usage when token allocation is exceeded",()=>{
  try{codexOutputGuard(codexAllocation(128,20000))(Buffer.from(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:129}})+"\n"));assert.fail();}catch(e:any){assert.equal(e.usage.outputTokens,129);assert.equal(routeCanFallback(e),false);}
});
test("Codex calls get the output schema and never send oversized input to inference",async()=>{
  let calls:any[]=[];const run=(async(_:string,options:any)=>{calls.push(options);if(calls.length===1)return Buffer.from("Logged in using ChatGPT\n");return Buffer.from([JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({output:"OK"})}}),JSON.stringify({type:"turn.completed",usage:{input_tokens:100,output_tokens:10}})].join("\n"));}) as typeof execCommand;
  const config=resolveModelConfigInput("codex-subscription","fixture")!,r=await callCodexSubscription(config,"system",[{role:"user",content:"test"}],{agent:"pm",maxOutput:128,maxInput:20000,run});assert.equal(r.text,"OK");assert.ok(calls[1].invocation.args.includes("--output-schema"));assert.equal(calls[1].timeout,60000);
  calls=[];await assert.rejects(callCodexSubscription(config,"system",[{role:"user",content:"too large"}],{agent:"pm",maxOutput:128,maxInput:100,run}),/input exceeds/);assert.equal(calls.length,1);
});
test("output guard cancels a supervised process before delayed side effects",async()=>{
  const target=path.join(process.cwd(),"late.txt"),code=`console.log('{"type":"turn.started"}');console.log('{"type":"turn.started"}');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(target)},'bad'),3000);`;
  await assert.rejects(execCommand("",{inspectStdout:codexOutputGuard(codexAllocation(128,20000)),invocation:{file:process.execPath,args:["-e",code]}}),/extra Codex turn/);assert.equal(fs.existsSync(target),false);
});
test("Copilot SDK starts text-only sessions and caps model output without inherited API credentials",async()=>{
  let config:any,handler:(e:any)=>void=()=>{},stopped=false;
  const client={start:async()=>{},getAuthStatus:async()=>({isAuthenticated:true,authType:"user"}),listModels:async()=>[{id:"fixture"}],createSession:async(c:any)=>{config=c;return {on:(h:any)=>{handler=h;},abort:async()=>{},sendAndWait:async()=>{handler({type:"assistant.usage",data:{inputTokens:20,outputTokens:5}});return {data:{content:"OK"}};}};},stop:async()=>{stopped=true;}};
  const result=await runCopilot({operation:"infer",model:"fixture",system:"system",messages:[],maxOutput:128},client as any);assert.ok("text" in result);assert.equal(result.text,"OK");assert.deepEqual(config.availableTools,[]);assert.equal(config.modelCapabilities.limits.max_output_tokens,128);assert.equal(stopped,true);
  const safe=copilotEnvironment({GH_TOKEN:"secret",GITHUB_TOKEN:"secret",COPILOT_GITHUB_TOKEN:"secret",OPENAI_API_KEY:"secret",PATH:"safe"});assert.equal(safe.GH_TOKEN,undefined);assert.equal(safe.PATH,"safe");assert.ok(fs.existsSync(copilotExecutable()));
});
test("Copilot needs a login and never silently turns into an API channel",async()=>{
  let sessions=0;await assert.rejects(runCopilot({operation:"infer"},{start:async()=>{},getAuthStatus:async()=>({isAuthenticated:false}),stop:async()=>{},createSession:async()=>{sessions++;}} as any),/SUBSCRIPTION_AUTH/);assert.equal(sessions,0);
  const c=loadConfig();c.models.copilot=resolveModelConfigInput("copilot-subscription","fixture")!;c.routing={profiles:{implement:["copilot"]}};assert.equal(resolveModelRoute(c,"worker","implement").candidates[0]!.config.transport,"copilot-sdk");
});
test("Copilot repeated calls/overspending aborts with measured usage and no paid fallback",async()=>{
  let handler:any;const client={start:async()=>{},getAuthStatus:async()=>({isAuthenticated:true}),listModels:async()=>[{id:"fixture"}],stop:async()=>{},createSession:async()=>({on:(h:any)=>handler=h,abort:async()=>{},sendAndWait:async()=>{handler({type:"assistant.usage",data:{inputTokens:10,outputTokens:100}});handler({type:"assistant.usage",data:{inputTokens:20,outputTokens:100}});return {data:{content:"bad"}};}})};
  await assert.rejects(runCopilot({operation:"infer",model:"fixture",messages:[],maxOutput:128},client as any),(e:any)=>e.usage.outputTokens===200&&!routeCanFallback(e));
  assert.throws(()=>parseCopilotResult(JSON.stringify({errorCode:"SUBSCRIPTION_BUDGET: copilot-allocation-exhausted",usage:{inputTokens:30,outputTokens:200}})),(e:any)=>e.usage.outputTokens===200);
});
test("reported overruns are fully charged, block further work and preserve communication allowance",()=>{
  process.env.SPAWN_SESSION_MAX_TOKENS="400";const j=sessionJournal();j.bind("pm","Leader");const config=resolveModelConfigInput("codex-subscription","fixture")!;
  const permit=reserveSessionRequest("pm",100,128,false,config)!;settleSessionRequest("pm",permit.id,120,200);assert.equal(j.budget()!.used.tokens,320);
  assert.throws(()=>reserveSessionRequest("pm",10,64,false,config),/SESSION_BUDGET/);
  const communication=reserveSessionRequest("pm",10,64,true,config)!;assert.equal(communication.communicationOnly,true);assert.equal(routeCanFallback(new Error("SUBSCRIPTION_BUDGET: HTTP 429")),false);
});

test("offline usage command stays local and has one unambiguous handler",()=>{
  const messages:string[]=[];const commands=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any);assert.equal(commands.filter(c=>c.name==="usage").length,1);commands.find(c=>c.name==="usage")!.handler([]);assert.equal(JSON.parse(messages[0]!)[0].state,"unknown");
});

test("budget stop survives restart and blocks automatic requests until an explicit user resume",async()=>{
  let calls=0;const server=http.createServer((req,res)=>{req.resume();calls++;res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({v:1,type:"message",agent:"pm",to:"user",text:"OK"})}}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const j=sessionJournal();j.bind("pm","Leader");j.append("runtime.event","pm","pm",j.currentRevision("pm")!,{v:1,type:"agent.error",agent:"pm",code:"http_error",detail:"SUBSCRIPTION_BUDGET: output exceeded allocation"});
  const config={id:"pm",role:"Leader",sessionManaged:true,providerCfg:{provider:"openai" as const,model:"mock",apiKey:"fixture",baseUrl:`http://127.0.0.1:${(server.address() as any).port}`}};
  const stopped=new HttpConvAgent(config);try{await stopped.send("[系统]继续工作");assert.equal(calls,0);assert.equal(j.budget(),undefined);stopped.kill();
    j.append("model.budget_resumed","pm","pm",j.currentRevision("pm")!,{reason:"explicit-user-input"});const resumed=new HttpConvAgent(config);try{await resumed.send("progress?");assert.equal(calls,1);}finally{resumed.kill();}
  }finally{stopped.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("model-scoped Claude limits do not block another model family",()=>{
  const rows=parseUsage("claude",{limits:[{kind:"weekly_scoped",percent:100,scope:{model:{display_name:"Claude Opus"}}}]});const snapshot:UsageSnapshot={provider:"claude",state:"fresh",checkedAt:100,observedAt:100,windows:rows};
  assert.equal(usageExhausted(snapshot,100,"sonnet"),false);assert.equal(usageExhausted(snapshot,100,"claude-opus-4-5"),true);assert.equal(usageExhausted(snapshot,100),false);
});
test("strict Codex token-cap policy refuses before launching or billing any model call",async()=>{
  process.env.SPAWN_CODEX_REQUIRE_HARD_TOKEN_CAP="1";let calls=0;
  await assert.rejects(callCodexSubscription(resolveModelConfigInput("codex-subscription","fixture")!,"",[],{agent:"pm",run:(async()=>{calls++;return Buffer.from("");}) as typeof execCommand}),/strict token-cap policy/);assert.equal(calls,0);
});

test("late model response after workspace shutdown cannot write or settle another session",async()=>{
  const root=process.cwd(),originalJournal=sessionJournal();originalJournal.bind("pm","Leader");let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let respond!:()=>void;
  const server=http.createServer((req,res)=>{req.resume();respond=()=>{res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify({v:1,type:"message",agent:"pm",to:"user",text:"LATE"})}}],usage:{prompt_tokens:10,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);};entered();});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const agent=new HttpConvAgent({id:"pm",role:"Leader",sessionManaged:true,providerCfg:{provider:"openai",model:"mock",apiKey:"fixture",baseUrl:`http://127.0.0.1:${(server.address() as any).port}`}});const events:any[]=[];agent.on("event",e=>events.push(e));
  try{const pending=agent.send("start");await ready;process.chdir(fs.mkdtempSync(path.join(scratch,"replacement-")));const replacement=sessionJournal();replacement.bind("pm","Leader");const seq=replacement.sequence().seq;agent.emit("event",{v:1,type:"message",agent:"pm",to:"user",text:"LATE_STREAM"});assert.equal(replacement.sequence().seq,seq);respond();await pending;assert.equal(replacement.budget(),undefined);assert.equal(events.some(e=>e.text==="LATE"),false);assert.ok(originalJournal.budget()!.used.tokens>20);}
  finally{agent.kill();process.chdir(root);server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("malformed dispatch mentioning agent.done cannot synthesize a successful completion",()=>{
  const events:any[]=[];parseAgentOutput('{"type":"spawn","dispatch":{"stop_conditions":["agent.done"]}}}',"pm",e=>events.push(e));assert.equal(events.length,0);
  assert.throws(()=>validateCodexHostProtocol('{"type":"message","agent":"pm","text":"first"}\n{"type":"spawn","dispatch":{"stop_conditions":["agent.done"]}}}',"pm"),/malformed host JSON/);
  assert.throws(()=>validateCodexHostProtocol('{"type":"message","agent":"someone-else"}',"pm"),/identity/);
});
for(const corrected of [true,false])test(`protocol rejection gets at most one budgeted correction; corrected=${corrected}`,async()=>{
  const j=sessionJournal();j.bind("pm","Leader");const agent=new HttpConvAgent({id:"pm",role:"Leader",sessionManaged:true,providerCfg:{provider:"openai",model:"mock",apiKey:"fixture"}});let calls=0;
  (agent as any)._callOpenAI=async()=>{calls++;if(!corrected||calls===1)throw Object.assign(new Error("SUBSCRIPTION_PROTOCOL: malformed host JSON; no events executed"),{usage:{inputTokens:10,outputTokens:10}});return {text:JSON.stringify({v:1,type:"message",agent:"pm",to:"user",text:"CORRECTED"}),promptTokens:10,completionTokens:10,ttftMs:0,totalMs:1};};
  const events:any[]=[];agent.on("event",e=>events.push(e));try{await agent.send("start");assert.equal(calls,2);assert.equal(j.budget()!.used.requests,2);assert.equal(j.budget()!.used.tokens,40);assert.equal(events.some(e=>e.text==="CORRECTED"),corrected);}finally{agent.kill();}
});
