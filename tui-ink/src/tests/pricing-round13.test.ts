import {DatabaseSync} from "node:sqlite";
import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {syncModelPrices,parsePriceSource,parseFx,priceSourceFor,priceSources,formatPriceStatus} from "../session/PriceSync.js";
import {auditReport} from "../session/Audit.js";
import {backgroundAuditReport} from "../session/BackgroundAudit.js";
import {SessionJournal,sessionJournal} from "../session/Journal.js";
import {reserveSessionRequest,settleSessionRequest} from "../session/Budget.js";
import {priceEndpoint,recordPrice} from "../session/Pricing.js";
import {restoreBackup} from "../session/Backup.js";
import {digest} from "../session/Storage.js";
import {waitForIndexing} from "../session/SearchIndex.js";
import {codexPrompt} from "../adapters/codexBudget.js";
import {HttpConvAgent} from "../adapters/httpAgent.js";
const original=process.cwd(),environment={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-round13-"));
const deepseek={provider:"openai",model:"deepseek-flash",baseUrl:"https://api.deepseek.com/v1",transport:"http" as const,billing:{mode:"api" as const}};
const kimi={...deepseek,model:"kimi-k3",baseUrl:"https://api.moonshot.cn/v1"};
beforeEach(()=>{process.chdir(fs.mkdtempSync(path.join(scratch,"case-")));process.env.SPAWN_CONFIG_DIR=path.resolve(".spawn/config");process.env.SPAWN_SESSION_MAX_REQUESTS="1000";process.env.SPAWN_SESSION_MAX_TOKENS="2000000";delete process.env.SPAWN_SESSION_MAX_USD;delete process.env.SPAWN_INPUT_USD_PER_MILLION;delete process.env.SPAWN_OUTPUT_USD_PER_MILLION;sessionJournal().bind("pm","Leader");});
afterEach(async()=>{await waitForIndexing();process.chdir(original);process.env={...environment};});
function ds(output=6){return `<table><tr><td colspan="3">MODEL</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>${["1M INPUT TOKENS (CACHE HIT)","1M INPUT TOKENS (CACHE MISS)","1M OUTPUT TOKENS"].map((label,i)=>`<tr>${i===0?'<td rowspan="6">PRICING</td>':""}<td rowspan="2">${label}</td><td>OFF-PEAK</td><td>$${i===2?output/2:1+i}</td><td>$1</td></tr><tr><td>PEAK</td><td>$${i===2?output:2+i}</td><td>$2</td></tr>`).join("")}</table>`;}
const km=(cn=true)=>`<DocTable\ncolumns={[{title:"Model"},{title:"Unit"},{title:"Cache Write Price (TTL 5min)"},{title:"Cache Write Price (TTL 1h)"},{title:"Cached Input Price"},{title:"Input Price"},{title:"Output Price"},{title:"Context Window"}]}\nrows={[\n["kimi-k3", "1M tokens", "${cn?"¥":"$"}2", "${cn?"¥":"$"}4", "${cn?"¥":"$"}1", "${cn?"¥":"$"}3", "${cn?"¥":"$"}5", "1000 tokens"],\n]}\n/>`;
const fx=(now:number)=>`<Cube time='${new Date(now).toISOString().slice(0,10)}'><Cube currency='USD' rate='1.1'/><Cube currency='CNY' rate='7.1'/></Cube>`;
const getter=(body=ds()):typeof fetch=>(async(url:any,options:any)=>{assert.equal(options.redirect,"error");assert.equal(options.headers?.Authorization,undefined);assert.equal(options.body,undefined);return new Response(body,{headers:{etag:'"fixture-v1"'}});}) as any;
const call=(model=deepseek)=>{const p=reserveSessionRequest("pm",100,100,false,model)!;settleSessionRequest("pm",p.id,20,10);return p;};
test("official parsers retain cache/tier prices, reject ambiguous units and never execute MDX",()=>{
  const d=parsePriceSource("deepseek",ds())[0]!;assert.equal(d.inputRate,3);assert.equal(d.outputRate,6);assert.equal(d.components.cachedOffPeak,1);
  assert.equal(parsePriceSource("kimiCN",km())[0]!.currency,"CNY");assert.equal(parsePriceSource("kimi",km(false))[0]!.inputRate,7);
  assert.throws(()=>parsePriceSource("deepseek",ds().replaceAll("1M ","1K ")),/schema/);assert.throws(()=>parsePriceSource("kimiCN",km(false)),/schema/);assert.throws(()=>parsePriceSource("kimi",km(false).replace("Cached Input Price","New Unsupported Column")),/schema/);assert.throws(()=>parsePriceSource("kimi",`process.exit();`),/schema/);
});
test("OpenRouter uses its own exact model IDs and scales per-token prices without accepting negative/dynamic fees",()=>{
  const body=JSON.stringify({data:[{id:"fixture/model",pricing:{prompt:"0.000001",completion:"0.000002",overrides:[{prompt:"0.000003",completion:"0.000004"}]}},{id:"bad/negative",pricing:{prompt:"-1",completion:"1"}},{id:"bad/request-fee",pricing:{prompt:"1",completion:"1",request:"1"}}]});
  const models=parsePriceSource("openrouter",body);assert.equal(models.length,1);assert.equal(models[0]!.inputRate,3);assert.equal(models[0]!.outputRate,4);
});
test("trusted source selection rejects proxy paths, lookalike hosts, subscriptions and credential URLs",()=>{
  assert.equal(priceSourceFor(deepseek),"deepseek");assert.equal(priceSourceFor(kimi),"kimiCN");
  for(const baseUrl of ["https://api.deepseek.com.evil.invalid/v1","https://proxy.invalid/v1","https://api.deepseek.com/proxy/v1","http://api.deepseek.com","https://secret@api.deepseek.com","https://api.deepseek.com?key=private"]){assert.equal(priceSourceFor({...deepseek,baseUrl}),undefined);}
  assert.equal(priceSourceFor({...deepseek,billing:{mode:"subscription"}}),undefined);
});
test("automatic sync is deduplicated, TTL cached and supplies immutable call-time prices",async()=>{
  let calls=0;const fetcher:typeof fetch=(async(...args:any[])=>{calls++;return getter()(...args as [any,any]);}) as any;
  await Promise.all([syncModelPrices([deepseek],undefined,{fetch:fetcher}),syncModelPrices([deepseek],undefined,{fetch:fetcher})]);assert.equal(calls,1);
  await syncModelPrices([deepseek],undefined,{fetch:fetcher});assert.equal(calls,1);call();
  const report=await auditReport(),row=report.rows.find(r=>r.kind==="settlement")!;assert.equal(row.priceQuote!.origin,"official");assert.equal(row.priceQuote!.basis,"upper-bound");assert.equal(row.inputRate,3);assert.equal(report.totals.microUsd,120);assert.equal(report.totals.unpriced,0);assert.ok(row.priceQuote!.version);assert.equal(row.priceQuote!.sourceDocumentHash,digest(ds()));assert.match(formatPriceStatus([deepseek]),/保守估算/);
});
test("HTTP 304 renews a verified price observation without replacing historical costs",async()=>{
  let now=Date.now();await syncModelPrices([deepseek],undefined,{fetch:getter(),now:()=>now});const initial=sessionJournal().prices()[0]!;call();now+=6*3600000+1;
  await syncModelPrices([deepseek],undefined,{now:()=>now,fetch:(async(_u:any,o:any)=>{assert.equal(o.headers["If-None-Match"],'"fixture-v1"');return new Response(null,{status:304});}) as any});
  const renewed=sessionJournal().prices()[0]!;assert.equal(renewed.version,initial.version);assert.equal(renewed.since,initial.since);assert.ok(renewed.expiresAt!>initial.expiresAt!);assert.equal((await auditReport()).totals.microUsd,120);
});
test("newly configured models fetch an unconditional catalog instead of accepting an unusable 304",async()=>{
  await syncModelPrices([deepseek],undefined,{fetch:getter()});const pro={...deepseek,model:"deepseek-v4-pro"};let calls=0;
  await syncModelPrices([pro],undefined,{fetch:(async(_u:any,o:any)=>{calls++;assert.deepEqual(o.headers,{});return new Response(ds());}) as any});assert.equal(calls,1);assert.ok(sessionJournal().prices().some(p=>p.model===pro.model));
});
test("changed official prices form a version chain and never rewrite old request estimates",async()=>{
  await syncModelPrices([deepseek],undefined,{fetch:getter()});const old=sessionJournal().prices()[0]!;call();const before=await auditReport();
  await syncModelPrices([deepseek],undefined,{force:true,fetch:getter(ds(12))});const next=sessionJournal().prices()[0]!;assert.notEqual(next.version,old.version);assert.equal(next.previousVersion,old.version);assert.ok(next.since>=old.since);
  const report=await auditReport();assert.deepEqual(report.totals,before.totals);assert.equal(report.priceDefinitions.length,2);assert.equal(report.rows.find(r=>r.kind==="settlement")!.priceQuote!.version,old.version);assert.equal(report.priceSync[0].changes,1);
});
test("unavailable sources retain the last verified quote and force refresh respects retry backoff",async()=>{
  await syncModelPrices([deepseek],undefined,{fetch:getter()});const old=sessionJournal().prices()[0]!;let calls=0;
  const fetcher=(async()=>{calls++;return new Response("private server diagnostics",{status:403});}) as any;
  await syncModelPrices([deepseek],undefined,{force:true,fetch:fetcher});await syncModelPrices([deepseek],undefined,{force:true,fetch:fetcher});assert.equal(calls,1);assert.equal(sessionJournal().prices()[0]!.version,old.version);assert.equal(sessionJournal().priceStatus()[0]!.code,"price-http-403");assert.doesNotMatch(JSON.stringify(await auditReport()),/private server diagnostics/);
});
test("malformed 200 responses and unsolicited 304 responses never supply zero prices",async()=>{
  for(const response of [new Response("<html>changed schema</html>"),new Response(null,{status:304})]){
    const root=fs.mkdtempSync(path.join(scratch,"bad-"));await syncModelPrices([deepseek],root,{fetch:(async()=>response) as any});assert.equal(sessionJournal(root).prices().length,0);assert.equal(sessionJournal(root).priceStatus()[0]!.state,"error");
  }
});
test("CNY prices use a separate verified reference conversion and preserve native components",async()=>{
  const now=Date.now();await syncModelPrices([kimi],undefined,{fetch:(async(url:any)=>new Response(String(url)===priceSources.fx?fx(now):km())) as any});
  const price=sessionJournal().prices()[0]!;assert.equal(price.currency,"CNY");assert.equal(price.components!.input,3);assert.equal(price.fx!.usdPerUnit,1.1/7.1);assert.ok(Math.abs(price.inputRate-7*1.1/7.1)<1e-10);assert.equal(price.fx!.source,priceSources.fx);
  assert.throws(()=>parseFx(fx(now-10*86400000),now),/stale/);assert.match(formatPriceStatus([kimi]),/原币 CNY/);
});
test("missing FX data cannot masquerade as a USD quote",async()=>{
  await syncModelPrices([kimi],undefined,{fetch:(async(url:any)=>String(url)===priceSources.fx?new Response("no FX",{status:503}):new Response(km())) as any});assert.equal(sessionJournal().prices().length,0);assert.equal(sessionJournal().priceStatus()[0]!.code,"fx-unavailable");
});
test("manual prices take precedence and an expired quote cannot satisfy a USD budget fence",async()=>{
  await syncModelPrices([deepseek],undefined,{fetch:getter()});process.env.SPAWN_SESSION_MAX_USD="0.01";call();const report=await auditReport();assert.equal(report.totals.microUsd,120);
  const manual={...deepseek,billing:{mode:"api" as const,inputUsdPerMillion:1,outputUsdPerMillion:1}};call(manual);assert.equal((await auditReport()).totals.microUsd,150);
  const old=sessionJournal().prices()[0]!;sessionJournal().append("pricing.defined","pm","test",0,{...old,since:Date.now()-2000,expiresAt:Date.now()-1});assert.throws(()=>call(),/cannot be enforced/);
});
test("automatic observations do not retroactively price old unknown requests",async()=>{
  call();await syncModelPrices([deepseek],undefined,{fetch:getter()});const report=await auditReport();assert.equal(report.pricing.unresolved,1);
  recordPrice(sessionJournal(),deepseek,1,1,{source:"verified-historical-contract"});assert.equal((await auditReport()).pricing.resolved,1);
});
test("stale source leases left by a dead process can be reclaimed",async()=>{
  fs.mkdirSync(".spawn/prices",{recursive:true});const file=path.join(".spawn/prices",digest(priceSources.deepseek)+".lock");fs.writeFileSync(file,"");const old=new Date(Date.now()-60000);fs.utimesSync(file,old,old);await syncModelPrices([deepseek],undefined,{fetch:getter()});assert.equal(sessionJournal().priceStatus()[0]!.state,"fresh");fs.writeFileSync(file,"99999999");await syncModelPrices([deepseek],undefined,{force:true,fetch:getter()});assert.equal(fs.existsSync(file),false);
});
test("price observations, versions and failure reasons survive retention and backup restore",async()=>{
  await syncModelPrices([deepseek],undefined,{fetch:getter()});call();const before=await auditReport();await sessionJournal().maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024});
  const cold=await auditReport();assert.equal(cold.index.visited,0);assert.ok(cold.index.rebasedSources>0);assert.deepEqual(cold.totals,before.totals);
  const backup=await sessionJournal().backup(),target=fs.mkdtempSync(path.join(scratch,"restore-"));await restoreBackup(process.cwd(),target,{id:backup.id});const restored=await auditReport(target);assert.deepEqual(restored.priceDefinitions,before.priceDefinitions);assert.deepEqual(sessionJournal(target).priceStatus(),sessionJournal().priceStatus());
});
test("sealed segment relocation reuses statistics and only processes the appended event",async()=>{
  call();const before=await auditReport();new SessionJournal(process.cwd(),{segmentBytes:1}).append("session.recovered","pm","pm",0,{});
  const next=await auditReport();assert.equal(next.index.visited,1);assert.ok(next.index.rebasedSources>0);assert.deepEqual(next.totals,before.totals);assert.equal((await auditReport()).index.visited,0);
});
test("a changed cold archive is not accepted just because its boundary matches the cached index",async()=>{
  call();await auditReport();await sessionJournal().maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024});const dir=path.resolve(".spawn/events/memory"),file=path.join(dir,fs.readdirSync(dir)[0]!);const bytes=fs.readFileSync(file);bytes[Math.floor(bytes.length/2)]!^=1;fs.writeFileSync(file,bytes);await assert.rejects(auditReport(),/integrity|check|invalid|incorrect/i);
});
test("a forced background rebuild leaves the parent event loop available for PM input",async()=>{
  for(let i=0;i<50;i++)call();let ticks=0;const timer=setInterval(()=>ticks++,5);try{const report=await backgroundAuditReport(undefined,{rebuild:true});assert.equal(report.totals.requests,50);assert.ok(ticks>=3);}finally{clearInterval(timer);}
});
test("a requirement change while price sync is pending prevents the old model request",async()=>{
  delete process.env.SPAWN_PRICE_AUTO_SYNC;const oldFetch=globalThis.fetch;let fetched=false,release!:(response:Response)=>void,calls=0;
  globalThis.fetch=(async()=>{fetched=true;return new Promise<Response>(r=>release=r);}) as any;
  const agent=new HttpConvAgent({id:"pm",role:"Leader",sessionManaged:true,providerCfg:{...deepseek,provider:"openai",apiKey:"fixture"}});(agent as any)._callOpenAI=async()=>{calls++;return {text:"",promptTokens:1,completionTokens:1};};
  try{const pending=agent.send("old requirement");const end=Date.now()+5000;while(!fetched&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(fetched,true);sessionJournal().append("requirement.changed","pm","pm",1,{text:"new goal"});release(new Response(ds()));await pending;assert.equal(calls,0);}finally{agent.kill();globalThis.fetch=oldFetch;}
});

test("stateless subscription prompts separate the active PM follow-up from completed dispatch history",()=>{
  const prompt=codexPrompt("host JSON protocol",[{role:"user",content:"START old dispatch"},{role:"assistant",content:"spawn old-worker"},{role:"user",content:"PROGRESS?"}]);
  const active=prompt.split("Active incoming turn:\n")[1]!;assert.equal(JSON.parse(active).content,"PROGRESS?");assert.doesNotMatch(active,/START|old-worker/);assert.match(prompt,/Previous completed turns/);assert.match(prompt,/do not replay/);
});

test("previous-version audit manifests acquire verified anchors without replaying cached accounting",async()=>{
  call();new SessionJournal(process.cwd(),{segmentBytes:1}).append("session.recovered","pm","pm",0,{});const first=await auditReport();
  const db=new DatabaseSync(path.resolve(".spawn/audit-cache/index.sqlite")),row=db.prepare("SELECT json FROM meta WHERE id=1").get() as {json:string};const value=JSON.parse(row.json);value.version=1;for(const source of value.manifest)delete source.lastHash;db.prepare("UPDATE meta SET json=?,hash=? WHERE id=1").run(JSON.stringify(value),digest(value));db.close();
  const upgraded=await auditReport();assert.equal(upgraded.index.visited,0);assert.deepEqual(upgraded.totals,first.totals);
  await sessionJournal().maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024});const cold=await auditReport();assert.equal(cold.index.visited,0);assert.deepEqual(cold.totals,first.totals);
});
