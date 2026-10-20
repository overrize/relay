import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {cachedUsage,refreshUsage,UsageError} from "../subscriptions/usage.js";
import {fetchUsage} from "../subscriptions/usageProviders.js";
import {formatUsage,formatBudget,formatModelConfig} from "../tui/accountStatus.js";
import {loadConfig,resolveModelConfigInput,saveModelConfig} from "../config.js";
import {sessionJournal,SessionJournal} from "../session/Journal.js";
import {reserveSessionRequest,settleSessionRequest,budgetReport} from "../session/Budget.js";
import {buildCommands} from "../tui/commands.js";

const original=process.cwd(),env={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-round10-"));
beforeEach(()=>{const root=fs.mkdtempSync(path.join(scratch,"case-"));process.chdir(root);process.env.SPAWN_USAGE_CACHE_DIR=path.join(root,"quota");process.env.SPAWN_SESSION_MAX_REQUESTS="4";process.env.SPAWN_COMMUNICATION_REQUESTS="1";});
afterEach(()=>{process.chdir(original);process.env={...env};});

test("403 retains HTTP evidence without guessing invalid login or leaking response",async(t)=>{
  const home=path.join(process.cwd(),"claude");fs.mkdirSync(home);fs.writeFileSync(path.join(home,".credentials.json"),JSON.stringify({claudeAiOauth:{accessToken:"fixture-private-token"}}));process.env.CLAUDE_CONFIG_DIR=home;
  t.mock.method(globalThis,"fetch",async()=>new Response("private host diagnostics",{status:403}));
  const value=await refreshUsage("claude",{fetch:()=>fetchUsage("claude")});
  assert.equal(value.httpStatus,403);assert.equal(value.errorCode,"usage-forbidden");assert.equal(value.attempts?.length,1);
  const display=formatUsage([cachedUsage("claude")],true);assert.match(display,/HTTP 403/);assert.match(display,/host/);assert.doesNotMatch(display,/登录失效|fixture-private-token|private host diagnostics/);
});
test("retry and cache reads keep attempt IDs; recovery persists bounded history",async()=>{
  let now=100000,calls=0;const fetch=async()=>{calls++;throw new UsageError("rate-limited",5000,429);};
  const options={fetch,now:()=>now,force:true};const first=await refreshUsage("copilot",options);
  const second=await refreshUsage("copilot",options);assert.equal(second.attempts![0]!.id,first.attempts![0]!.id);assert.equal(calls,1);
  for(let i=0;i<12;i++){now+=6000;await refreshUsage("copilot",options);}
  const restored=cachedUsage("copilot",now);assert.equal(restored.attempts!.length,10);assert.equal(new Set(restored.attempts!.map(a=>a.id)).size,10);assert.equal(calls,13);
});
test("empty successful responses and stale last good data have distinct reasons",async()=>{
  let now=100000;const options={now:()=>now,force:true};
  const empty=await refreshUsage("codex",{...options,fetch:async()=>[]});assert.equal(empty.errorCode,"no-quota-data");assert.match(formatUsage([empty]),/余额未知/);
  now+=6000;await refreshUsage("codex",{...options,fetch:async()=>[{label:"codex:primary",remainingPercent:70}]});
  now+=6000;const failed=await refreshUsage("codex",{...options,fetch:async()=>{throw new UsageError("codex-quota-timeout");}});
  assert.match(formatUsage([failed]),/过期，仅供参考/);assert.match(formatUsage([failed]),/剩余 70%/);assert.equal(failed.attempts!.length,3);
});
test("unknown failures never persist arbitrary diagnostics",async()=>{
  const value=await refreshUsage("copilot",{fetch:async()=>{throw new UsageError("private token and user details");}});assert.equal(value.errorCode,"usage-unavailable");assert.doesNotMatch(JSON.stringify(value),/private token/);
});
test("model display explains effective routing and redacts URL credentials and query",()=>{
  const cfg=loadConfig();cfg.models={sub:resolveModelConfigInput("codex-subscription","fixture")!,api:{provider:"openai",model:"fixture-api",apiKey:"private-key",baseUrl:"https://user:password@example.com/v1?key=private-query"}};cfg.routing={profiles:{pm:["sub","api"]},allowApiFallback:false};
  const display=formatModelConfig(cfg);assert.match(display,/api-fallback-disabled/);assert.match(display,/https:\/\/example.com/);assert.match(display,/模型未设价格/);assert.doesNotMatch(display,/private-key|password|private-query|user:/);assert.match(display,/不代表已登录/);
});
test("subscription registration rejects an accidentally supplied API key",()=>{
  for(const provider of ["codex","claude","copilot"])assert.equal(resolveModelConfigInput(`${provider}-subscription`,"fixture","extra-key"),null);
  assert.throws(()=>saveModelConfig("__proto__",resolveModelConfigInput("copilot-subscription","fixture")!),/registry/);
  assert.throws(()=>saveModelConfig("bad",{...resolveModelConfigInput("codex-subscription","fixture")!,apiKey:"extra-key"}),/requires/);
});
test("budget display separates API estimates, subscription usage, unknown bills and communication reserve",()=>{
  sessionJournal().bind("pm","Leader");const sub=reserveSessionRequest("pm",100,100,false,{model:"fixture",billing:{mode:"subscription"}})!;settleSessionRequest("pm",sub.id,10,20);
  reserveSessionRequest("pm",100,100,false,{model:"unknown",billing:{mode:"api"}});
  const display=formatBudget(budgetReport());assert.match(display,/订阅：1 请求 \/ 30 Token/);assert.match(display,/未定价 API 请求 1/);assert.match(display,/消耗不确定 1/);assert.match(display,/PM 沟通预留/);assert.match(display,/未设置美元上限/);
});
test("last actual model survives journal restart and only applies to matching revision",()=>{
  const j=sessionJournal();j.bind("pm","Leader");j.append("model.selected","pm","pm",0,{candidate:"registered",model:"fixture",transport:"codex-cli",billing:"subscription"});
  j.append("model.selected","pm","pm",99,{candidate:"stale",model:"bad",transport:"http",billing:"api"});
  const restored=new SessionJournal(process.cwd());assert.equal(restored.binding("pm")!.modelSelection!.candidate,"registered");assert.match(formatBudget((reserveSessionRequest("pm",100,100),budgetReport()),restored.bindings()),/registered · codex-cli · subscription/);
});
test("offline account, usage and budget commands never issue network requests",(t)=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error("unexpected network");});const messages:string[]=[];
  const commands=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any);
  for(const name of ["account","budget","usage"])commands.find(c=>c.name===name)!.handler([]);
  commands.find(c=>c.name==="usage")!.handler(["--json"]);assert.equal(JSON.parse(messages[3]!)[0].state,"unknown");assert.equal(calls,0);
});
test("async usage failure preserves command responsiveness and query evidence",async()=>{
  const messages:string[]=[];const commands=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any);
  // Seed backoff so this command exercises completion without touching accounts.
  await refreshUsage("copilot",{fetch:async()=>{throw new UsageError("copilot-login-required");}});
  commands.find(c=>c.name==="usage")!.handler(["refresh","copilot"]);commands.find(c=>c.name==="budget")!.handler([]);
  assert.equal(messages.length,2);await new Promise(r=>setImmediate(r));assert.match(messages[2]!,/待 Copilot 登录验证/);
});
