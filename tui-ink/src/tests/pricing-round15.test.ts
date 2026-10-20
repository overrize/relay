import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {SessionJournal,sessionJournal} from '../session/Journal.js';
import {importPriceTable,trustPriceTable,revisePriceTable,readPriceTable} from '../session/PriceImport.js';
import {reserveSessionRequest,settleSessionRequest} from '../session/Budget.js';
import {auditReport} from '../session/Audit.js';
import {priceFor,priceEndpoint,recordPrice} from '../session/Pricing.js';
import {restoreBackup} from '../session/Backup.js';
import {buildCommands} from '../tui/commands.js';
import {splitCommand} from '../tui/splitCommand.js';
const parent=path.resolve('.test-tmp');fs.mkdirSync(parent,{recursive:true});const scratch=fs.mkdtempSync(path.join(parent,'prices15-'));after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
const row=(extra:any={})=>({source:'contract-A',issuer:'Agency',provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1',currency:'USD',unit:'per-million-tokens',inputRate:2,outputRate:4,effectiveFrom:'2020-01-01T00:00:00Z',effectiveTo:null,...extra});
function table(root:string,name:string,rows=[row()]){const file=path.join(root,name+'.json');fs.writeFileSync(file,JSON.stringify({version:1,prices:rows}));return file;}
async function fixture(){const root=fs.mkdtempSync(path.join(scratch,'case-')),file=table(root,'original'),trusted=trustPriceTable(root,file,'Agency');await importPriceTable(root,file,{apply:true});return {root,file,digest:trusted.digest,j:new SessionJournal(root)};}
function replacement(root:string,rows=[row({inputRate:3,outputRate:6})]){const file=table(root,'revised',rows);trustPriceTable(root,file,[...new Set(rows.map(r=>r.issuer))].sort().join(','));return file;}
const pick=(j:SessionJournal)=>priceFor({provider:'openai',model:'model-A',endpoint:priceEndpoint('openai','https://proxy.example/v1'),at:Date.now()} as any,j.effectivePrices());
async function inRoot(root:string,use:()=>Promise<void>){const cwd=process.cwd(),env={...process.env};try{process.chdir(root);delete process.env.SPAWN_SESSION_MAX_USD;delete process.env.SPAWN_INPUT_USD_PER_MILLION;delete process.env.SPAWN_OUTPUT_USD_PER_MILLION;sessionJournal().bind('pm','Leader');await use();}finally{process.chdir(cwd);process.env={...env};}}
const previewToken=(result:Awaited<ReturnType<typeof revisePriceTable>>)=>{assert.ok('preview' in result);return result.preview;};
const selection={provider:'openai',model:'model-A',baseUrl:'https://proxy.example/v1'};
const call=()=>{const r=reserveSessionRequest('pm',100,100,false,selection)!;settleSessionRequest('pm',r.id,20,10);return r.id;};
test('revoke previews, preserves versions/reason, and is idempotent without resurrection',async()=>{
 const {root,digest,file,j}=await fixture(),seq=j.sequence().seq;const preview=await revisePriceTable(root,digest,{reason:'incorrect price'});assert.equal(j.sequence().seq,seq);assert.equal(pick(j)?.inputRate,2);
 const result=await revisePriceTable(root,digest,{reason:'incorrect price',apply:true,expect:previewToken(preview)});assert.equal(result.state,'revoked');assert.equal(j.sequence().seq,seq+1);assert.equal(pick(j),undefined);assert.equal((await revisePriceTable(root,digest,{reason:'incorrect price',apply:true})).state,'already-revoked');assert.equal(j.sequence().seq,seq+1);await assert.rejects(importPriceTable(root,file,{apply:true}),/RETIRED_BATCH/);
 const audit=await auditReport(root);assert.equal(audit.priceDefinitions[0]!.retired!.reason,'incorrect price');assert.equal(audit.priceRevisions[0].id,result.revision);assert.ok(audit.rows.some(r=>r.kind==='price-revision'));
});
test('replace retires and introduces prices in one event with linked revision provenance',async()=>{
 const {root,digest,j}=await fixture(),file=replacement(root),seq=j.sequence().seq;const preview=await revisePriceTable(root,digest,{file,reason:'invoice correction'});assert.equal(pick(j)?.inputRate,2);const result=await revisePriceTable(root,digest,{file,reason:'invoice correction',expect:previewToken(preview),apply:true});assert.equal(result.state,'replaced');assert.equal(j.sequence().seq,seq+1);assert.equal(pick(j)?.inputRate,3);assert.equal(pick(j)?.replacesDigest,digest);const report=await auditReport(root);assert.equal(report.priceDefinitions.length,2);assert.equal(report.priceDefinitions[0]!.retired!.replacementDigest,readPriceTable(file).digest);assert.equal((await revisePriceTable(root,digest,{file,reason:'invoice correction',apply:true})).state,'already-replaced');assert.equal(j.sequence().seq,seq+1);
});
test('bad sources, same batch, invalid scope and issuer never retire the current quote',async()=>{
 const {root,digest,j,file}=await fixture();await assert.rejects(revisePriceTable(root,digest,{file,reason:'same',apply:true}),/REPLACE_SAME_BATCH/);
 await assert.rejects(revisePriceTable(root,digest,{file:'',reason:'empty replacement',apply:true}),/REPLACEMENT_FILE/);
 const untrusted=table(root,'untrusted',[row({inputRate:9})]);await assert.rejects(revisePriceTable(root,digest,{file:untrusted,reason:'bad source',apply:true}),/SOURCE_UNTRUSTED/);
 for(const patch of [{model:'other'},{baseUrl:'https://other-proxy.example'},{issuer:'Other'}]){const f=replacement(root,[row(patch)]);await assert.rejects(revisePriceTable(root,digest,{file:f,reason:'wrong',apply:true}),/REPLACEMENT_SCOPE|ISSUER_MISMATCH/);assert.equal(pick(j)?.inputRate,2);}
});
test('replacement windows cannot collide with a different active batch',async()=>{
 const root=fs.mkdtempSync(path.join(scratch,'case-')),a=table(root,'a',[row({effectiveTo:'2025-01-01T00:00:00Z'})]),b=table(root,'b',[row({effectiveFrom:'2025-01-01T00:00:00Z'})]);const target=trustPriceTable(root,a,'Agency').digest;trustPriceTable(root,b,'Agency');await importPriceTable(root,a,{apply:true});await importPriceTable(root,b,{apply:true});const file=replacement(root);await assert.rejects(revisePriceTable(root,target,{file,reason:'overlap',apply:true}),/INTERVAL_CONFLICT/);assert.equal((await auditReport(root)).priceDefinitions.filter(p=>p.retired).length,0);
});
test('stale preview and missing reason fail; PM conversation alone does not invalidate preview',async()=>{
 const {root,digest,j}=await fixture();for(const reason of ['', '  ','bad\nreason'])await assert.rejects(revisePriceTable(root,digest,{reason,apply:true}),/REVISION_REASON/);await assert.rejects(revisePriceTable(root,'short',{reason:'bad'}),/TARGET_DIGEST/);await assert.rejects(revisePriceTable(root,'0'.repeat(64),{reason:'bad'}),/TARGET_NOT_FOUND/);
 const preview=await revisePriceTable(root,digest,{reason:'fix'});j.append('note','pm','user',0,{text:'progress'});assert.equal((await revisePriceTable(root,digest,{reason:'fix',expect:previewToken(preview)})).state,'preview');trustPriceTable(root,replacement(root),'Agency');await assert.rejects(revisePriceTable(root,digest,{reason:'fix',expect:previewToken(preview),apply:true}),/PREVIEW_STALE/);await assert.rejects(revisePriceTable(root,digest,{reason:'different',expect:previewToken(preview),apply:true}),/PREVIEW_STALE/);
});
test('an invalid row cannot leave a partially revoked batch',async()=>{
 const {root,digest,j}=await fixture(),file=table(root,'invalid',[row({inputRate:9}),row({inputRate:-1})]),seq=j.sequence().seq;await assert.rejects(revisePriceTable(root,digest,{file,reason:'bad',apply:true}),/RATE_INVALID/);assert.equal(j.sequence().seq,seq);assert.equal(pick(j)?.inputRate,2);
});
test('known replacement files cannot be used to create cycles or revive retired batches',async()=>{
 const {root,digest,file,j}=await fixture(),next=replacement(root);await revisePriceTable(root,digest,{file:next,reason:'fix',apply:true});const nextDigest=readPriceTable(next).digest;await assert.rejects(revisePriceTable(root,nextDigest,{file,reason:'rollback',apply:true}),/REPLACEMENT_ALREADY_KNOWN/);await assert.rejects(revisePriceTable(root,digest,{reason:'another action',apply:true}),/TARGET_RETIRED/);assert.equal(pick(j)?.inputRate,3);
});
test('reserved, settled, uncertain and future calls retain their own price snapshots',async()=>{
 const {root,digest}=await fixture();await inRoot(root,async()=>{
 const first=call(),pending=reserveSessionRequest('pm',100,100,false,selection)!,uncertain=reserveSessionRequest('pm',100,100,false,selection)!;settleSessionRequest('pm',uncertain.id);const before=await auditReport(root),j=sessionJournal(),used=j.budget()!.used.microUsd;
 const file=replacement(root);await revisePriceTable(root,digest,{file,reason:'corrected',apply:true});assert.equal(j.budget()!.used.microUsd,used);settleSessionRequest('pm',pending.id,20,10);const latest=call(),report=await auditReport(root);
 for(const id of [first,pending.id,uncertain.id]){const r=report.rows.find(r=>r.id===id)!;assert.equal(r.inputRate,2);assert.equal(r.priceQuote!.retired,undefined);if(id===first)assert.deepEqual(r,before.rows.find(r=>r.id===id));}
 assert.equal(report.rows.find(r=>r.id===pending.id)!.microUsd,80);assert.equal(report.rows.find(r=>r.id===latest)!.microUsd,120);const atRevoke=j.budget()!.used.microUsd;await revisePriceTable(root,readPriceTable(file).digest,{reason:'withdraw',apply:true});assert.equal(j.budget()!.used.microUsd,atRevoke);const unknown=call(),after=await auditReport(root);assert.equal(after.rows.find(r=>r.id===unknown)!.pricingKnown,false);assert.equal(after.rows.find(r=>r.id===latest)!.microUsd,120);
 });
});
test('historical supplements recalculate separately; original charges never change',async()=>{
 const root=fs.mkdtempSync(path.join(scratch,'case-'));await inRoot(root,async()=>{const id=call(),file=table(root,'original'),digest=trustPriceTable(root,file,'Agency').digest;await importPriceTable(root,file,{apply:true});const j=sessionJournal(),used=j.budget()!.used.microUsd;
 const supplement=async()=>{const report=await auditReport(root);assert.equal(report.totals.microUsd,0);return report.rows.find(r=>r.id===id)!.supplement;};const initial=(await supplement())!;assert.ok('microUsd' in initial);assert.equal(initial.microUsd,80);
 const next=replacement(root);await revisePriceTable(root,digest,{file:next,reason:'correct historical estimate',apply:true});const revised=(await supplement())!;assert.ok('microUsd' in revised);assert.equal(revised.microUsd,120);await revisePriceTable(root,readPriceTable(next).digest,{reason:'unverified',apply:true});assert.equal((await supplement())!.state,'missing-price');assert.equal(j.budget()!.used.microUsd,used);const incremental=await auditReport(root),rebuild=await auditReport(root,{rebuild:true});assert.deepEqual(rebuild.priceDefinitions,incremental.priceDefinitions);assert.deepEqual(rebuild.priceRevisions,incremental.priceRevisions);assert.deepEqual(rebuild.pricing,incremental.pricing);
 });
});
test('revoked proxy price cannot silently bypass an existing USD cap',async()=>{
 const {root,digest}=await fixture();await inRoot(root,async()=>{process.env.SPAWN_SESSION_MAX_USD='10';call();const used=structuredClone(sessionJournal().budget()!.used);await revisePriceTable(root,digest,{reason:'incorrect quote',apply:true});assert.throws(()=>call(),/cannot be enforced/);assert.deepEqual(sessionJournal().budget()!.used,used);});
});
test('price correction between quote selection and reservation is retried before outbound use',async()=>{
 const {root,digest}=await fixture(),file=replacement(root),preview=await revisePriceTable(root,digest,{file,reason:'race fix'});assert.ok('prices' in preview);await inRoot(root,async()=>{
 const original=SessionJournal.prototype.append;let injected=false;SessionJournal.prototype.append=function(kind,...args:any[]){if(kind==='budget.reserved'&&!injected){injected=true;original.call(this,'pricing.revised','pm','user',0,preview);}return (original as any).call(this,kind,...args);};
 try{const id=call(),report=await auditReport(root);assert.equal(report.totals.requests,1);assert.equal(report.rows.find(r=>r.id===id)!.inputRate,3);assert.equal(sessionJournal().budget()!.used.requests,1);}finally{SessionJournal.prototype.append=original;}
 });
});
test('revision state and lineage survive retention, process-independent rebuild and backup restore',async()=>{
 const {root,digest,j}=await fixture(),file=replacement(root);await revisePriceTable(root,digest,{file,reason:'fix',apply:true});await revisePriceTable(root,readPriceTable(file).digest,{reason:'withdraw',apply:true});const before=await auditReport(root);await j.maintain({maxLogBytes:0,retentionMs:0});const backup=await j.backup(),target=path.join(root,'restored');await restoreBackup(root,target,{id:backup.id});const after=await auditReport(target,{rebuild:true});assert.deepEqual(after.priceDefinitions,before.priceDefinitions);assert.deepEqual(after.priceRevisions,before.priceRevisions);assert.equal(pick(new SessionJournal(target)),undefined);await assert.rejects(importPriceTable(target,file,{apply:true}),/RETIRED_BATCH/);recordPrice(new SessionJournal(target),selection,1,1,{source:'manual-after-withdrawal'});
});
test('TUI revision commands support quoted paths and reasons and return asynchronously',async()=>{
 const {root,digest}=await fixture();await inRoot(root,async()=>{const messages:string[]=[],commands=buildCommands({emitCommandMessage:(s:string)=>messages.push(s)} as any),args=splitCommand(`prices revoke ${digest} reason="incorrect unit" --apply`);commands.find(c=>c.name==='prices')!.handler(args.slice(1));assert.match(messages[0]!,/PM/);const end=Date.now()+5000;while(!messages.some(m=>m.includes('"state": "revoked"'))){if(Date.now()>end)assert.fail(messages.join('\n'));await new Promise(r=>setTimeout(r,10));}assert.equal(pick(new SessionJournal(root)),undefined);});
});
