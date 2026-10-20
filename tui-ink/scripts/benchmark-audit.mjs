// Offline generated history: no model calls, credentials or paid requests.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SessionJournal} from '../dist/session/Journal.js';
import {auditReport} from '../dist/session/Audit.js';
const count=Number(process.argv[2]??10000);if(!Number.isSafeInteger(count)||count<1||count>1000000)throw Error('Request count must be 1..1000000');
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/audit-benchmark-')),directory=path.join(root,'.spawn/events');fs.mkdirSync(directory,{recursive:true});
let seq=0,lastHash='',lines=[];
const entry=(kind,data)=>{const body={version:1,seq:++seq,id:`event-${seq}`,ts:1700000000000+seq,kind,conversation:'pm',agent:'pm',revision:0,data};const hash=createHash('sha256').update(lastHash+JSON.stringify(body)).digest('hex');lastHash=hash;lines.push(JSON.stringify({...body,hash}));};
// Match the Journal's canonical hash implementation exactly.
for(let i=0;i<count;i++){
  entry('budget.reserved',{id:`request-${i}`,reservation:{model:'offline-fixture',provider:'openai',transport:'http',billingMode:'api',pricingKnown:true,inputRate:2,outputRate:4,tokens:200,microUsd:600}});
  entry('budget.settled',{id:`request-${i}`,tokens:30,microUsd:80,inputTokens:20,outputTokens:10});
}
fs.mkdirSync(path.join(directory,'segments'),{recursive:true});
for(let from=0;from<lines.length;from+=1000){const chunk=lines.slice(from,from+1000),last=from+1000>=lines.length,name=last?'journal.jsonl':`segments/${String(from+1).padStart(16,'0')}-${String(from+chunk.length).padStart(16,'0')}.jsonl`;fs.writeFileSync(path.join(directory,name),chunk.join('\n')+'\n');}
lines=[];
const timed=async filter=>{const start=performance.now(),report=await auditReport(root,filter);return {ms:Math.round(performance.now()-start),report};};
const first=await timed(),warm=await timed({before:first.report.rows.at(-1).seq,limit:10});assert.equal(first.report.totals.requests,count);assert.equal(warm.report.index.visited,0);assert.ok(warm.report.index.projectionReplayedEvents<=1000);assert.equal(warm.report.totals.microUsd,count*80);
const j=new SessionJournal(root);j.append('session.recovered','pm','pm',0,{});const incremental=await timed();assert.equal(incremental.report.index.visited,1);
const forced=await timed({rebuild:true});assert.deepEqual(forced.report.totals,first.report.totals);
new SessionJournal(root,{segmentBytes:1}).append('session.recovered','pm','pm',0,{});const relocated=await timed();assert.equal(relocated.report.index.visited,1);assert.ok(relocated.report.index.rebasedSources>0);
const maintenanceStart=performance.now();await new SessionJournal(root).maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:512*1024*1024});const maintenanceMs=Math.round(performance.now()-maintenanceStart),retained=await timed();assert.deepEqual(retained.report.totals,first.report.totals);assert.equal(retained.report.index.visited,0);assert.ok(retained.report.index.rebasedSources>0);
console.log(JSON.stringify({forcedRebuildMs:forced.ms,rotationReuseMs:relocated.ms,retentionReuseMs:retained.ms,maintenanceMs,retentionRebasedSources:retained.report.index.rebasedSources,retentionEventsReprocessed:retained.report.index.visited,root,requests:count,events:seq,coldMs:first.ms,warmMs:warm.ms,incrementalMs:incremental.ms,warmEventsRead:0,incrementalEventsRead:1,warmProjectionReplay:warm.report.index.projectionReplayedEvents,warmProjectionBytes:warm.report.index.projectionBytesRead,sqliteBytes:fs.statSync(path.join(root,'.spawn/audit-cache/index.sqlite')).size},null,2));console.log('AUDIT_BENCHMARK_PASS');
