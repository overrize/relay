import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readPublish} from '../dist/worklog/Config.js';
import {WorkStore,digest} from '../dist/worklog/Store.js';
import {SecretaryAgent} from '../dist/worklog/Reports.js';
import {WorkPublisher} from '../dist/worklog/Publisher.js';
import {FeishuDocs} from '../dist/worklog/FeishuDocs.js';
// Resume the original verification namespace. Never create a new employee or document.
const [configFile,verificationFile,marker]=process.argv.slice(2);
if(!configFile||!verificationFile||!marker)throw Error('Pass publisher.json, original verification.json and the employee edit marker');
const saved=JSON.parse(fs.readFileSync(verificationFile,'utf8'));
assert.equal(saved.realFeishu,true);assert.match(saved.verificationEmployee,/^verification-/);
const cfg=readPublish(path.resolve(configFile)),employee={...cfg.employees[0],id:saved.verificationEmployee};
const config={...cfg,store:path.join(saved.root,'store'),employees:[employee],model:undefined};
assert.ok(fs.existsSync(config.store),'Original verification store is required');
const store=new WorkStore(config.store);
let writes=0;
const cloud=new FeishuDocs(config,async(url,init)=>{
 if(new URL(String(url)).pathname==='/open-apis/docx/v1/documents'&&init?.method==='POST')throw Error('VERIFICATION_MUST_NOT_CREATE_DOCUMENTS');
 if(init?.method&&init.method!=='GET')writes++;
 return fetch(url,init);
});
try{
 const documents=store.db.prepare('SELECT id,token FROM documents ORDER BY id').all();
 assert.equal(documents.length,4);assert.deepEqual(documents.map(d=>({...d})).sort((a,b)=>a.id.localeCompare(b.id)),[...saved.documents].sort((a,b)=>a.id.localeCompare(b.id)));
 const reports=documents.filter(d=>!d.id.startsWith('audit:')).map(d=>store.latest(d.id));
 assert.ok(reports.every(r=>r.tenant===config.tenant&&r.employee===employee.id));
 const daily=reports.find(r=>r.kind==='daily'),weekly=reports.find(r=>r.kind==='weekly');assert.ok(daily&&weekly);
 const originals=store.db.prepare('SELECT id,version,json,hash FROM reports ORDER BY id,version').all();
 const publisher=new WorkPublisher(store,config,cloud);
 await publisher.syncEdits();
 const edits=store.db.prepare("SELECT id,json,hash FROM revisions WHERE report=? AND kind='employee-edit'").all(daily.id);
 assert.ok(edits.some(r=>JSON.parse(r.json).edits.some(t=>t.includes(marker))),'Employee browser edit must be persisted');
 for(const r of edits)assert.equal(digest(JSON.parse(r.json)),r.hash);
 const next=await new SecretaryAgent(store,config).generate(employee.id,'weekly',weekly.start);
 assert.ok(next.body.includes(marker));assert.ok(next.basis.revisions.length);
 const result=await publisher.publish();
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE status!='complete'").get().n,0,JSON.stringify(store.db.prepare('SELECT status,reason FROM outbox').all()));
 const doc=id=>documents.find(d=>d.id===id).token;
 const dailyCloud=await cloud.snapshot(doc(daily.id)),weeklyCloud=await cloud.snapshot(doc(weekly.id));
 assert.ok(dailyCloud.blocks.some(b=>b.text.includes(marker)));assert.ok(weeklyCloud.blocks.some(b=>b.text.includes(marker)));
 const audit=await cloud.snapshot(doc('audit:'+daily.id));
 assert.ok(audit.blocks.some(b=>b.text.includes(marker)));assert.ok(audit.blocks.map(b=>b.text).join('').includes('sourceEvidence'));
 for(const original of originals)assert.deepEqual(store.db.prepare('SELECT id,version,json,hash FROM reports WHERE id=? AND version=?').get(original.id,original.version),original);
 // Feishu splits JSON inside arbitrary text blocks; reconstruct each entry before validating.
 const entries=[];let parts=[];
 for(const block of audit.blocks){if(block.text.startsWith('[WORKLOG AUDIT ENTRY ')){if(parts.length)entries.push(JSON.parse(parts.join('')));parts=[];}else if(block.text)parts.push(block.text);}
 if(parts.length)entries.push(JSON.parse(parts.join('')));
 assert.ok(entries.some(e=>e.generation&&e.sourceEvidence?.length));
 for(const entry of entries){if(entry.generation){assert.equal(digest(entry.generation),entry.hash);for(const source of entry.sourceEvidence)assert.equal(digest(source.event),source.hash);}if(entry.revision)assert.equal(digest(entry.revision.value),entry.revision.hash);}
 for(const document of documents){
  const members=await cloud.api(`drive/v1/permissions/${document.token}/members?type=docx&fields=*`);
  assert.ok(members.items.some(m=>m.member_type==='openid'&&m.member_id===employee.openId&&m.perm===(document.id.startsWith('audit:')?'view':'edit')));
  const permissions=await cloud.api(`drive/v2/permissions/${document.token}/public?type=docx`);
  assert.equal(permissions.permission_public.external_access_entity,'closed');assert.equal(permissions.permission_public.link_share_entity,'closed');
 }
 const revisionCount=store.db.prepare('SELECT count(*) AS n FROM revisions').get().n;
 await publisher.syncEdits();assert.equal(store.db.prepare('SELECT count(*) AS n FROM revisions').get().n,revisionCount,'Unchanged cloud content must not produce duplicate edits');
 const verified=store.verifyAudit();
 const proof={realFeishu:true,existingDocumentsReused:true,documentCount:documents.length,employeeBrowserEdit:marker,revisionCount,weeklyVersion:next.version,originalReportsUnchanged:true,cloudAuditEvidence:true,cloudEvidenceHashesVerified:true,employeePermissionsVerified:true,publicSharingClosed:true,idempotentEditSync:true,audit:verified,publish:result,writes,documents};
 fs.writeFileSync(path.join(saved.root,'edit-verification.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}finally{store.close();}


