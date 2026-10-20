import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {auditReport,auditReason} from "../session/Audit.js";
import {sessionJournal,SessionJournal} from "../session/Journal.js";
import {reserveSessionRequest,settleSessionRequest,budgetReport} from "../session/Budget.js";
import {refreshUsage,UsageError} from "../subscriptions/usage.js";
import {restoreBackup} from "../session/Backup.js";
import {buildCommands} from "../tui/commands.js";
import {HttpConvAgent} from "../adapters/httpAgent.js";
import {waitForIndexing} from "../session/SearchIndex.js";

const original=process.cwd(),env={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-round11-"));
beforeEach(()=>{const root=fs.mkdtempSync(path.join(scratch,"case-"));process.chdir(root);process.env.SPAWN_SESSION_MAX_REQUESTS="1000";process.env.SPAWN_COMMUNICATION_REQUESTS="2";process.env.SPAWN_SESSION_MAX_TOKENS="2000000";process.env.SPAWN_USAGE_CACHE_DIR=path.join(root,"cache");delete process.env.SPAWN_SESSION_MAX_USD;});
afterEach(async()=>{await waitForIndexing();process.chdir(original);process.env={...env};});
const api={provider:"openai",model:"fixture-api",transport:"http",billing:{mode:"api" as const,inputUsdPerMillion:2,outputUsdPerMillion:4}};
const sub={provider:"openai",model:"fixture-sub",transport:"codex-cli",billing:{mode:"subscription" as const}};
function call(agent="pm",selection=api,unknown=false){const p=reserveSessionRequest(agent,100,100,false,selection)!;settleSessionRequest(agent,p.id,unknown?undefined:20,unknown?undefined:10);return p;}
const policy={maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024};

test("lifetime aggregates outlive the 200-request cache and retain unknown consumption",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");for(let i=0;i<220;i++)call("pm",api,true);
  assert.equal(Object.keys(j.budget()!.reservations).length,200);
  const report=await auditReport();assert.equal(report.totals.requests,220);assert.equal(report.totals.uncertain,220);assert.equal(report.totals.tokens,44000);assert.equal(report.totals.microUsd,132000);assert.equal(report.byModel[0]!.uncertain,220);assert.equal(report.rows.length,40);
});
test("retry attempts aggregate to logical tasks and requirement revisions stay distinct",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");
  for(const id of ["w1","w2"]){j.bind(id,"Worker","pm");j.append("task.attempt","pm","pm",0,{id:"task-one",agent:id});call(id);}
  j.append("requirement.changed","pm","pm",1,{text:"private new requirement"});j.bind("w3","Worker","pm");j.append("task.attempt","pm","pm",1,{id:"task-two",agent:"w3"});call("w3");
  const report=await auditReport();assert.deepEqual(report.byTask.map(t=>[t.task,t.revision,t.requests]),[["task-one",0,2],["task-two",1,1]]);assert.doesNotMatch(JSON.stringify(report),/private new requirement/);
});
test("API and subscription are separate groups, with immutable call-time prices",async()=>{
  sessionJournal().bind("pm","Leader");call();const p=reserveSessionRequest("pm",100,100,false,sub)!;settleSessionRequest("pm",p.id,30,20);
  const report=await auditReport();assert.equal(report.byModel.length,2);assert.equal(report.byModel.find(g=>g.billing==="subscription")!.microUsd,0);assert.equal(report.totals.microUsd,80);assert.equal(report.totals.tokens,80);assert.equal(report.rows.find(r=>r.model==="fixture-api"&&r.kind==="settlement")!.outputRate,4);
});
test("pending interrupted requests and duplicate settlement never refund or double count",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");const p=reserveSessionRequest("pm",100,100,false,api)!;call();const settled=call();j.append("budget.settled","pm","pm",0,{id:settled.id,tokens:99999,microUsd:99999});j.append("session.recovered","pm","pm",0,{});
  const report=await auditReport();assert.equal(report.totals.pending,1);assert.equal(report.totals.tokens,260);assert.ok(report.rows.some(r=>r.reason==="interrupted"));assert.ok(report.rows.some(r=>r.id===p.id));
});
test("query audit outlives the ten-entry quota cache and log retention",async()=>{
  let now=100000;for(let i=0;i<12;i++){await refreshUsage("copilot",{force:true,now:()=>now,fetch:async()=>{throw new UsageError("copilot-login-required");}});now+=61000;}
  const j=sessionJournal();await j.maintain(policy);const report=await auditReport();assert.equal(report.quotaQueries,12);assert.equal(report.rows.filter(r=>r.kind==="quota").length,12);assert.ok(report.rows.every(r=>r.reason==="copilot-login-required"));
});
test("cold archive, backup restore and a fresh process reproduce the audit totals and stop causes",async()=>{
  const root=process.cwd(),j=sessionJournal();j.bind("pm","Leader");call();j.append("runtime.event","pm","pm",0,{type:"agent.error",agent:"pm",code:"http_error",detail:"SUBSCRIPTION_BUDGET: private raw diagnostics"});
  await j.maintain(policy);const before=await auditReport();const backup=await j.backup();
  const restored=path.join(root,"restored");await restoreBackup(root,restored,{id:backup.id});assert.deepEqual((await auditReport(restored)).totals,before.totals);
  const loader=new URL("../../node_modules/tsx/dist/esm/index.mjs",import.meta.url).href,module=new URL("../session/Audit.ts",import.meta.url).href;
  const result=await promisify(execFile)(process.execPath,["--import",loader,"--input-type=module","-e",`const {auditReport}=await import(${JSON.stringify(module)});console.log(JSON.stringify(await auditReport(${JSON.stringify(restored)})));`],{windowsHide:true});
  const after=JSON.parse(result.stdout);assert.deepEqual(after.totals,before.totals);assert.ok(after.rows.some((r:any)=>r.reason==="SUBSCRIPTION_BUDGET"));assert.doesNotMatch(result.stdout,/private raw diagnostics/);
});
test("old backup spending-floor differences are explicit rather than attributed to fabricated tasks",async()=>{
  const root=process.cwd(),j=sessionJournal();j.bind("pm","Leader");call();const b=await j.backup();call();await restoreBackup(root,root,{id:b.id,replace:true});const offline=await auditReport();assert.equal(offline.floorGap.requests,1);budgetReport();
  const report=await auditReport();assert.equal(report.totals.requests,1);assert.equal(report.floorGap.requests,1);assert.equal(report.byModel[0]!.requests,1);assert.ok(report.rows.some(r=>r.kind==="budget-floor"));
});
test("detail pagination and model/task filters do not alter lifetime totals",async()=>{
  sessionJournal().bind("pm","Leader");for(let i=0;i<5;i++)call();
  const first=await auditReport(process.cwd(),{model:"fixture-api",limit:3}),next=await auditReport(process.cwd(),{before:first.nextBefore,limit:3});
  assert.equal(first.totals.requests,5);assert.deepEqual(first.totals,next.totals);assert.ok(next.rows.every(r=>r.seq<first.nextBefore!));assert.equal(new Set([...first.rows,...next.rows].map(r=>r.seq)).size,6);
  const missing=await auditReport(process.cwd(),{task:"absent"});assert.equal(missing.rows.length,0);assert.equal(missing.totals.requests,5);
});
test("history scans capture a stable boundary while PM can append new messages",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");call();const initial=j.sequence().seq;let wrote=false;
  const seen:number[]=[];const through=await j.visitHistory(e=>{seen.push(e.seq);if(!wrote){wrote=true;j.append("message.recorded","pm","pm",0,{role:"user",content:"live PM input"});}});
  assert.equal(through.seq,initial);assert.equal(Math.max(...seen),initial);assert.equal(j.sequence().seq,initial+1);
});
test("corrupt protected archives refuse accounting rather than exporting partial totals",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");call();await j.maintain(policy);
  const directory=path.join(process.cwd(),".spawn/events/memory"),file=path.join(directory,fs.readdirSync(directory)[0]!);const bytes=fs.readFileSync(file);bytes[Math.floor(bytes.length/2)]!^=1;fs.writeFileSync(file,bytes);
  await assert.rejects(auditReport());
});
test("request failure is durably linked to its reservation and sanitized",async()=>{
  const j=sessionJournal();j.bind("pm","Leader");const agent=new HttpConvAgent({id:"pm",role:"Leader",sessionManaged:true,providerCfg:{provider:"openai",model:"fixture",apiKey:"fixture"}});
  (agent as any)._callOpenAI=async()=>{throw new Error("SESSION_BUDGET_EXHAUSTED: private provider error");};
  try{await agent.send("status");}finally{agent.kill();}
  const report=await auditReport();const failure=report.rows.find(r=>r.kind==="request-failed")!;assert.equal(failure.reason,"SESSION_BUDGET_EXHAUSTED");assert.ok(failure.requestId);assert.ok(report.rows.some(r=>r.id===failure.requestId));assert.doesNotMatch(JSON.stringify(report),/private provider error/);
});
test("audit command returns immediately and rejects unsafe pagination parameters",async()=>{
  const messages:string[]=[];const commands=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any);commands.find(c=>c.name==="audit")!.handler([]);assert.equal(messages.length,1);
  const deadline=Date.now()+5000;while(messages.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.match(messages[1]!,/长期审计/);await assert.rejects(auditReport(process.cwd(),{limit:10000}));assert.equal(auditReason("token=private"),"unspecified");
});
