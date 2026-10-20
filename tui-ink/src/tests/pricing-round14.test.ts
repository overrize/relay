import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {readPriceTable,trustPriceTable,importPriceTable} from '../session/PriceImport.js';
import {SessionJournal,sessionJournal} from '../session/Journal.js';
import {reserveSessionRequest,settleSessionRequest} from '../session/Budget.js';
import {priceFor,recordPrice,priceEndpoint} from '../session/Pricing.js';
import {auditReport} from '../session/Audit.js';
import {restoreBackup} from '../session/Backup.js';
import {splitCommand} from '../tui/splitCommand.js';
const parent=path.resolve('.test-tmp');fs.mkdirSync(parent,{recursive:true});const scratch=fs.mkdtempSync(path.join(parent,'prices14-'));
after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const row=(extra:any={})=>({source:'contract-A',issuer:'Agency',provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1',currency:'USD',unit:'per-million-tokens',inputRate:2,outputRate:4,effectiveFrom:'2025-01-01T00:00:00Z',effectiveTo:'2026-01-01T00:00:00Z',...extra});
function fixture(rows=[row()]){const root=fs.mkdtempSync(path.join(scratch,'case-')),file=path.join(root,'price table.json');fs.writeFileSync(file,JSON.stringify({version:1,prices:rows}));return {root,file};}
function trust(root:string,file:string){return trustPriceTable(root,file,'Agency');}
const pick=(prices:any[],at:string,baseUrl='https://proxy.example/v1')=>priceFor({provider:'openai',model:'model-A',endpoint:priceEndpoint('openai',baseUrl),at:Date.parse(at)} as any,prices);
test('untrusted, changed and mismatched source files cannot be committed',async()=>{
 const {root,file}=fixture();await assert.rejects(importPriceTable(root,file,{apply:true}),/SOURCE_UNTRUSTED/);assert.throws(()=>trustPriceTable(root,file,'Other'),/ISSUER_MISMATCH/);trust(root,file);fs.writeFileSync(file,JSON.stringify({version:1,prices:[row({inputRate:9})]}));await assert.rejects(importPriceTable(root,file,{apply:true}),/SOURCE_UNTRUSTED/);assert.equal(new SessionJournal(root).effectivePrices().length,0);
});
test('preview has no pricing side effects; apply is atomic and retry is idempotent',async()=>{
 const {root,file}=fixture([row(),row({effectiveFrom:'2026-01-01T00:00:00Z',effectiveTo:null,inputRate:3})]);trust(root,file);const preview=await importPriceTable(root,file);const j=new SessionJournal(root);assert.equal(j.effectivePrices().length,0);await importPriceTable(root,file,{apply:true,expect:preview.preview});const seq=j.sequence().seq;assert.equal((await importPriceTable(root,file,{apply:true})).state,'already-imported');assert.equal(j.sequence().seq,seq);assert.equal(pick(j.effectivePrices(),'2025-01-01T00:00:00Z')?.inputRate,2);assert.equal(pick(j.effectivePrices(),'2026-01-01T00:00:00Z')?.inputRate,3);assert.equal(pick(j.effectivePrices(),'2024-12-31T23:59:59Z'),undefined);assert.equal(pick(j.effectivePrices(),'2025-06-01T00:00:00Z','https://different.example'),undefined);
});
test('overlapping, duplicate and internally conflicting windows reject whole batch',async()=>{
 for(const rows of [[row(),row()],[row(),row({effectiveFrom:'2025-06-01T00:00:00Z'})]]){const {root,file}=fixture(rows);trust(root,file);const j=new SessionJournal(root),seq=j.sequence().seq;await assert.rejects(importPriceTable(root,file,{apply:true}),/INTERVAL_CONFLICT/);assert.equal(j.sequence().seq,seq);}
});
test('existing manual history is checked even after checkpoint and compaction',async()=>{
 const {root,file}=fixture();const j=new SessionJournal(root);recordPrice(j,{provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1'},1,1,{source:'manual'});for(let i=0;i<35;i++)j.append('note','pm','user',0,{i});await j.maintain({maxLogBytes:0,retentionMs:0});trust(root,file);await assert.rejects(importPriceTable(root,file,{apply:true}),/INTERVAL_CONFLICT/);
});
test('later manual prices cannot silently override imported contract windows',async()=>{
 const {root,file}=fixture();trust(root,file);await importPriceTable(root,file,{apply:true});assert.throws(()=>recordPrice(new SessionJournal(root),{provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1'},9,9,{source:'manual'}),/INTERVAL_CONFLICT/);
});
test('preview token rejects stale review after concurrent changes',async()=>{
 const {root,file}=fixture();trust(root,file);const preview=await importPriceTable(root,file);new SessionJournal(root).append('pricing.sync','pm','sync',0,{source:'fixture',state:'fresh'});await assert.rejects(importPriceTable(root,file,{apply:true,expect:preview.preview}),/PREVIEW_STALE/);
});
test('strict units, calendar dates, intervals, credentials and unknown fields fail closed',()=>{
 for(const patch of [{inputRate:-1},{outputRate:'Infinity'},{inputRate:'0x10'},{unit:'per-token'},{currency:'EUR'},{effectiveFrom:'2025-02-30T00:00:00Z'},{effectiveFrom:'2025-01-01T24:00:00Z'},{effectiveFrom:'2025-01-01'},{effectiveTo:'2024-01-01T00:00:00Z'},{baseUrl:'https://user:secret@proxy.example/v1'},{baseUrl:'https://proxy.example/v1?key=secret'},{baseUrl:'http://remote.example'},{apiKey:'secret'}]){const {file}=fixture([row(patch)]);assert.throws(()=>readPriceTable(file));}
});
test('CSV quoted records and BOM are supported without allowing duplicate columns',()=>{
 const {file}=fixture();const csv=file.replace('.json','.csv'),r=row(),headers=Object.keys(r);fs.writeFileSync(csv,'\uFEFF'+headers.join(',')+'\r\n'+Object.values(r).map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')+'\r\n');assert.equal(readPriceTable(csv).prices[0]!.inputRate,2);fs.writeFileSync(csv,'source,source\nA,B');assert.throws(()=>readPriceTable(csv),/CSV_HEADER/);
});
test('supporting document hashes and directory containment are verified',()=>{
 const {root,file}=fixture();fs.writeFileSync(path.join(root,'source.txt'),'contract');const hash=createHash('sha256').update('contract').digest('hex');fs.writeFileSync(file,JSON.stringify({version:1,prices:[row({document:'source.txt',documentSha256:hash})]}));assert.equal(readPriceTable(file).prices[0]!.sourceDocumentHash,hash);fs.writeFileSync(path.join(root,'source.txt'),'changed');assert.throws(()=>readPriceTable(file),/DOCUMENT_HASH/);
 fs.writeFileSync(file,JSON.stringify({version:1,prices:[row({document:'../outside',documentSha256:hash})]}));fs.writeFileSync(path.join(scratch,'outside'),'contract');assert.throws(()=>readPriceTable(file),/DOCUMENT_PATH/);
});
test('historical CNY requires explicit pinned FX and preserves original amounts',()=>{
 const {file}=fixture([row({currency:'CNY'})]);assert.throws(()=>readPriceTable(file));fs.writeFileSync(file,JSON.stringify({version:1,prices:[row({currency:'CNY',usdPerUnit:0.14,fxSource:'contract-FX',fxDate:'2025-01-01'})]}));const p=readPriceTable(file).prices[0]!;assert.equal(p.inputRate,0.28);assert.equal(p.components!.inputRate,2);assert.equal(p.fx!.date,'2025-01-01');
});
test('contract priority, gaps and expiry never apply prices outside the effective interval',async()=>{
 const {root,file}=fixture();const j=new SessionJournal(root);j.append('pricing.defined','pm','sync',0,{...readPriceTable(file).prices[0],origin:'official',source:'official',since:0,expiresAt:undefined,inputRate:8});trust(root,file);await importPriceTable(root,file,{apply:true});assert.equal(pick(j.effectivePrices(),'2025-06-01T00:00:00Z')!.inputRate,2);assert.equal(pick(j.effectivePrices(),'2026-01-01T00:00:00Z')!.inputRate,8);
});
test('imports and trust survive restart, retention and backup restore with audit provenance',async()=>{
 const {root,file}=fixture();trust(root,file);await importPriceTable(root,file,{apply:true});const before=await auditReport(root);assert.equal(before.priceDefinitions.length,1);assert.ok(before.rows.some(r=>r.kind==='price-import'));const j=new SessionJournal(root);await j.maintain({maxLogBytes:0,retentionMs:0});const backup=await j.backup(),target=path.join(root,'restore');await restoreBackup(root,target,{id:backup.id});const restored=await auditReport(target);assert.deepEqual(restored.priceDefinitions,before.priceDefinitions);assert.equal(new SessionJournal(target).trustedPriceTable(readPriceTable(file).digest),'Agency');assert.equal(new SessionJournal(target).effectivePrices().length,1);
});
test('quoted TUI paths preserve Windows backslashes and never invoke shell syntax',()=>{assert.deepEqual(splitCommand('prices import "E:\\my data\\table.json" --apply'),['prices','import','E:\\my data\\table.json','--apply']);assert.deepEqual(splitCommand('prices import "unfinished'),[]);});

test('historical supplements keep original costs while future calls snapshot contract rates',async()=>{
 const {root,file}=fixture([row({effectiveFrom:'2020-01-01T00:00:00Z',effectiveTo:null})]),cwd=process.cwd(),env={...process.env};
 try{process.chdir(root);delete process.env.SPAWN_SESSION_MAX_USD;delete process.env.SPAWN_INPUT_USD_PER_MILLION;delete process.env.SPAWN_OUTPUT_USD_PER_MILLION;const j=sessionJournal();j.bind('pm','Leader');const selection={provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1'};
 const unknown=reserveSessionRequest('pm',100,100,false,selection)!;settleSessionRequest('pm',unknown.id,20,10);const before=j.budget()!.used.microUsd;trust(root,file);await importPriceTable(root,file,{apply:true});assert.equal(j.budget()!.used.microUsd,before);
 const current=reserveSessionRequest('pm',100,100,false,selection)!;settleSessionRequest('pm',current.id,20,10);const report=await auditReport(root),old=report.rows.find(r=>r.id===unknown.id)!,next=report.rows.find(r=>r.id===current.id)!;
 assert.equal(old.microUsd,0);assert.equal(old.supplement?.state,'supplemented');assert.equal(old.supplement?.microUsd,80);assert.equal(next.microUsd,80);assert.equal(next.priceQuote?.origin,'contract');assert.equal(report.pricing.resolved,1);
 }finally{process.chdir(cwd);process.env={...env};}
});

test('PM communication after preview does not invalidate the reviewed price book',async()=>{
 const {root,file}=fixture();trust(root,file);const preview=await importPriceTable(root,file);const j=new SessionJournal(root);for(let i=0;i<10;i++)j.append('note','pm','user',0,{text:'progress'});assert.equal((await importPriceTable(root,file,{apply:true,expect:preview.preview})).state,'imported');
});

test('journal append tolerates a short worker-thread read lock without stopping PM',async()=>{
 const {root}=fixture(),j=new SessionJournal(root);j.append('note','pm','user',0,{});const lock=j.file+'.lock';
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');fs.writeFileSync(workerData,String(process.pid),{flag:'wx'});parentPort.postMessage('locked');setTimeout(()=>fs.unlinkSync(workerData),100);`,{eval:true,workerData:lock});
 await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});j.append('note','pm','user',0,{text:'PM continues'});assert.equal(j.sequence().seq,2);await worker.terminate();
});

test('a persistent live journal lock is bounded and never force-unlocked',()=>{
 const {root}=fixture(),j=new SessionJournal(root);j.append('note','pm','user',0,{});const lock=j.file+'.lock';fs.writeFileSync(lock,String(process.pid));const start=Date.now();try{assert.throws(()=>j.append('note','pm','user',0,{}),/writing this session/);assert.ok(Date.now()-start<3000);assert.equal(fs.readFileSync(lock,'utf8'),String(process.pid));}finally{fs.unlinkSync(lock);}assert.equal(j.sequence().seq,1);
});
