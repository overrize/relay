import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile,spawn} from "node:child_process";
import {promisify} from "node:util";
import {DatabaseSync} from "node:sqlite";
import {auditReport,formatAudit} from "../session/Audit.js";
import {sessionJournal} from "../session/Journal.js";
import {reserveSessionRequest,settleSessionRequest} from "../session/Budget.js";
import {recordPrice,priceEndpoint} from "../session/Pricing.js";
import {restoreBackup} from "../session/Backup.js";
import {buildCommands} from "../tui/commands.js";
import {saveModelConfig,loadConfig} from "../config.js";
import {waitForIndexing} from "../session/SearchIndex.js";
const original=process.cwd(),environment={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-round12-"));
const api={provider:"openai",model:"fixture",baseUrl:"https://example.invalid/v1",transport:"http" as const,billing:{mode:"api" as const}};
beforeEach(()=>{process.chdir(fs.mkdtempSync(path.join(scratch,"case-")));process.env.SPAWN_SESSION_MAX_REQUESTS="1000";process.env.SPAWN_SESSION_MAX_TOKENS="2000000";delete process.env.SPAWN_SESSION_MAX_USD;delete process.env.SPAWN_INPUT_USD_PER_MILLION;delete process.env.SPAWN_OUTPUT_USD_PER_MILLION;process.env.SPAWN_CONFIG_DIR=path.resolve(".spawn/config");sessionJournal().bind("pm","Leader");});
afterEach(async()=>{await waitForIndexing();process.chdir(original);process.env={...environment};});
function call(model=api,measured=true){const p=reserveSessionRequest("pm",100,100,false,model)!;settleSessionRequest("pm",p.id,measured?20:undefined,measured?10:undefined);return p;}
const indexFile=()=>path.resolve(".spawn/audit-cache/index.sqlite");
test("incremental audit reads only new entries and pagination/restart read zero history entries",async()=>{
  for(let i=0;i<25;i++)call();const first=await auditReport();assert.equal(first.index.mode,"rebuilt");assert.ok(first.index.visited>50);
  const next=await auditReport(undefined,{limit:2,before:first.rows[1]!.seq});assert.equal(next.index.visited,0);assert.equal(next.rows.length,2);assert.deepEqual(next.totals,first.totals);
  call();const update=await auditReport();assert.equal(update.index.mode,"incremental");assert.equal(update.index.visited,2);assert.equal(update.totals.requests,26);assert.equal(update.pricing.unresolved,26);
  const result=await promisify(execFile)(process.execPath,["--import","tsx/esm","--input-type=module","-e",`import {auditReport} from ${JSON.stringify(new URL("../session/Audit.ts",import.meta.url).href)}; console.log(JSON.stringify(await auditReport(${JSON.stringify(process.cwd())})))`],{cwd:original,windowsHide:true});
  const fresh=JSON.parse(result.stdout);assert.equal(fresh.index.visited,0);assert.deepEqual(fresh.totals,update.totals);const rebuild=await auditReport(undefined,{rebuild:true});assert.equal(rebuild.index.mode,"rebuilt");assert.deepEqual(rebuild.totals,fresh.totals);
});
test("checksum failure and a corrupt SQLite file rebuild only disposable data",async()=>{
  call();const before=await auditReport(),db=new DatabaseSync(indexFile());db.exec("UPDATE meta SET hash='broken'");db.close();
  assert.equal((await auditReport()).index.mode,"rebuilt");fs.writeFileSync(indexFile(),"not a database");const rebuilt=await auditReport();assert.equal(rebuilt.index.mode,"rebuilt");assert.deepEqual(rebuilt.totals,before.totals);
});
test("rotated logs, retention and backup restore retain prices and rebuild the index",async()=>{
  call();recordPrice(sessionJournal(),api,2,4,{source:"test-price-sheet"});const first=await auditReport();assert.equal(first.pricing.microUsd,80);
  await sessionJournal().maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024});const cold=await auditReport();assert.deepEqual(cold.totals,first.totals);assert.deepEqual(cold.pricing,first.pricing);
  const backup=await sessionJournal().backup(),target=path.join(scratch,"restored-"+Date.now());await restoreBackup(process.cwd(),target,{id:backup.id});const restored=await auditReport(target);assert.deepEqual(restored.pricing,first.pricing);assert.deepEqual(restored.totals,first.totals);assert.equal(restored.index.mode,"rebuilt");
});
test("old backup restore invalidates a future index and preserves floor gaps",async()=>{
  call();const backup=await sessionJournal().backup();call();const future=await auditReport();assert.equal(future.totals.requests,2);
  await restoreBackup(process.cwd(),process.cwd(),{id:backup.id,replace:true});const old=await auditReport();assert.equal(old.index.mode,"rebuilt");assert.equal(old.totals.requests,1);assert.equal(old.floorGap.requests,1);
});
test("source changes invalidate cache even at the same sequence and corrupt sources fail closed",async()=>{
  call();await auditReport();const file=path.resolve(".spawn/events/journal.jsonl"),text=fs.readFileSync(file,"utf8");fs.writeFileSync(file,text.replace('"kind":"budget.reserved"','"kind":"budget.reserveX"'));
  await assert.rejects(auditReport(),/integrity|hash|checksum/i);
});
test("explicit backfill resolves measured fees without rewriting immutable budget amounts",async()=>{
  call();const before=await auditReport(),spent=sessionJournal().budget()!.used.microUsd;assert.equal(before.pricing.unresolved,1);
  recordPrice(sessionJournal(),api,2,4,{source:"contract-2026"});const after=await auditReport();assert.equal(after.totals.microUsd,0);assert.equal(after.pricing.resolved,1);assert.equal(after.pricing.microUsd,80);assert.equal(sessionJournal().budget()!.used.microUsd,spent);assert.equal(after.rows.find(r=>r.kind==="settlement")!.supplement!.state,"supplemented");assert.match(formatAudit(after),/后补估算/);
  call();const more=await auditReport();assert.equal(more.index.visited,2);assert.equal(more.pricing.resolved,2);assert.equal(more.pricing.microUsd,160);assert.equal((await auditReport()).index.visited,0);
});
test("effective dates and endpoint identity prevent applying a proxy or future price to old requests",async()=>{
  call();recordPrice(sessionJournal(),{...api,baseUrl:"https://other.invalid/v1"},1,1,{source:"other-proxy"});assert.equal((await auditReport()).pricing.unresolved,1);
  recordPrice(sessionJournal(),api,2,4,{source:"future",since:Date.now()+86400000});assert.equal((await auditReport()).pricing.unresolved,1);
  recordPrice(sessionJournal(),api,3,5,{source:"right-contract"});assert.equal((await auditReport()).pricing.microUsd,110);
  assert.equal(priceEndpoint("openai","https://user:password@example.invalid/v1?key=secret"),priceEndpoint("openai","https://example.invalid"));
  assert.doesNotMatch(JSON.stringify(await auditReport()),/password|key=secret/);
});
test("pending and unknown usage remain unmeasured even after a zero-dollar price is supplied",async()=>{
  call(api,false);reserveSessionRequest("pm",100,100,false,api);recordPrice(sessionJournal(),api,0,0,{source:"explicit-free-tier"});const report=await auditReport();assert.equal(report.pricing.unmeasured,2);assert.equal(report.pricing.resolved,0);assert.equal(report.totals.pending,1);assert.equal(report.totals.uncertain,1);
});
test("legacy endpoint-free history requires explicit legacy authorization",async()=>{
  const j=sessionJournal();j.append("budget.reserved","pm","pm",0,{id:"legacy",reservation:{model:api.model,provider:api.provider,tokens:30,microUsd:0,billingMode:"api",pricingKnown:false}});j.append("budget.settled","pm","pm",0,{id:"legacy",tokens:30,microUsd:0,inputTokens:20,outputTokens:10});
  recordPrice(j,api,2,4,{source:"contract"});assert.equal((await auditReport()).pricing.unresolved,1);recordPrice(j,api,2,4,{source:"verified-legacy-contract",legacy:true});assert.equal((await auditReport()).pricing.resolved,1);
});
test("invalid price entries are rejected and subscriptions never become per-token API fees",async()=>{
  assert.throws(()=>recordPrice(sessionJournal(),api,-1,1,{source:"bad"}),/Invalid/);assert.throws(()=>recordPrice(sessionJournal(),api,1,1,{source:"bad",since:NaN}),/Invalid/);
  call({...api,billing:{mode:"subscription" as any}});recordPrice(sessionJournal(),api,99,99,{source:"contract"});const report=await auditReport();assert.equal(report.totals.unpriced,0);assert.equal(report.pricing.microUsd,0);assert.equal(report.pricing.resolved,0);
});
test("same-process concurrent audit pages serialize and produce identical totals",async()=>{
  call();const [a,b]=await Promise.all([auditReport(undefined,{limit:1}),auditReport(undefined,{limit:2})]);assert.deepEqual(a.totals,b.totals);assert.equal(b.index.visited,0);assert.equal(b.rows.length,2);
});
test("a killed indexing transaction rolls back and a fresh audit can recover",async()=>{
  call();const before=await auditReport();
  const code=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(indexFile())});db.exec("BEGIN IMMEDIATE; UPDATE meta SET hash='uncommitted'; DELETE FROM rows;");console.log('READY');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","pipe","pipe"],windowsHide:true});
  const exited=new Promise(resolve=>child.once("exit",resolve));
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Child transaction did not start")),10000);child.once("error",reject);child.stdout!.once("data",()=>{clearTimeout(timer);resolve();});});}finally{child.kill("SIGKILL");await exited;}
  const recovered=await auditReport();assert.deepEqual(recovered.totals,before.totals);assert.deepEqual(recovered.rows,before.rows);assert.equal(recovered.index.visited,0);
});
test("TUI price command validates input, persists a source, updates future config and backfills history",async()=>{
  saveModelConfig("fixture",{...api,provider:"openai",apiKey:"private-fixture-key"});call();
  const messages:string[]=[],command=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any).find(c=>c.name==="price")!;
  command.handler(["fixture","2","4","source=contract-2026"]);
  assert.match(messages.at(-1)!,/已持久记录/);const cfg=loadConfig().models.fixture!;assert.equal(cfg.billing!.priceSource,"contract-2026");assert.equal(cfg.billing!.outputUsdPerMillion,4);
  const report=await auditReport();assert.equal(report.pricing.resolved,1);assert.doesNotMatch(JSON.stringify(report)+messages.join(""),/private-fixture-key/);
  const seq=sessionJournal().sequence().seq;command.handler(["fixture","-1","4","source=bad"]);assert.equal(sessionJournal().sequence().seq,seq);
});
test("new priced requests preserve the call-time price source and never get backfilled twice",async()=>{
  const priced={...api,billing:{mode:"api" as const,inputUsdPerMillion:2,outputUsdPerMillion:4,priceSource:"locked-contract",priceRecordedAt:123}};call(priced);recordPrice(sessionJournal(),api,99,99,{source:"later-contract"});
  const report=await auditReport(),row=report.rows.find(r=>r.kind==="settlement")!;assert.equal(report.totals.microUsd,80);assert.equal(report.pricing.resolved,0);assert.equal(row.priceSource,"locked-contract");assert.equal(row.priceRecordedAt,123);assert.equal(row.supplement,undefined);
});
test("an index exceeding its independent quota is evicted without changing memory or billing",async()=>{
  call();process.env.SPAWN_AUDIT_INDEX_MAX_BYTES="1024";const first=await auditReport();assert.equal(first.index.retained,false);
  const next=await auditReport();assert.equal(next.index.mode,"rebuilt");assert.deepEqual(next.totals,first.totals);assert.deepEqual(next.rows,first.rows);assert.ok(sessionJournal().history("pm"));
  delete process.env.SPAWN_AUDIT_INDEX_MAX_BYTES;const cached=await auditReport();assert.equal(cached.index.retained,true);assert.equal((await auditReport()).index.visited,0);
});
