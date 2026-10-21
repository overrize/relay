import {test,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {pathToFileURL} from 'node:url';
import {SessionJournal} from '../session/Journal.js';
import {loadRetention} from '../session/Storage.js';
import {transcriptPage,closeTranscriptReaders} from '../session/Transcript.js';
const exec=promisify(execFile);fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/transcript27-'));
after(async()=>{await closeTranscriptReaders();fs.rmSync(root,{recursive:true,force:true});});
async function fixture(name:string){const folder=path.join(root,name),j=new SessionJournal(folder,{automatic:false,segmentBytes:2048});j.bind('pm','Leader');for(let i=0;i<160;i++)j.append('message.recorded','pm','pm',0,{role:'user',content:`HISTORY_${i} `+'历史 '.repeat(110)});const result=await j.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:64*1024*1024});assert.deepEqual(result.errors,[]);return {folder,j};}

test('baseline copies share per-file metadata checks; ordered prefetch preserves evidence with logarithmic lookup and bounded descriptors',async()=>{
 const {folder,j}=await fixture('scan'),events=path.join(folder,'.spawn/events'),counts=new Map<string,number>(),original=fs.statSync;
 const probe=mock.method(fs,'statSync',((file:any,...args:any[])=>{if(String(file).includes(path.join('events','memory')))counts.set(String(file),(counts.get(String(file))??0)+1);return (original as any)(file,...args);}) as any);
 let baseline;try{baseline=loadRetention(events);}finally{probe.mock.restore();}assert.ok(baseline!.archives.length>30);assert.equal(counts.size,baseline!.archives.length);assert.ok([...counts.values()].every(n=>n===1));
 const capture=j.historySources(),before={...j.stats},seen:number[]=[];await j.visitHistory(e=>{seen.push(e.seq);},undefined,undefined,{capture,prefetch:4});assert.equal(new Set(seen).size,seen.length);assert.equal(seen.at(-1),j.sequence().seq);
 assert.equal(j.stats.historyBatches-before.historyBatches,Math.ceil(capture.sources.length/4));assert.ok(j.stats.maxPrefetch<=4);assert.ok(j.stats.sourceLookupSteps-before.sourceLookupSteps<=capture.sources.length*(Math.ceil(Math.log2(capture.sources.length))+1));
 const sequential:number[]=[];await j.visitHistory(e=>{sequential.push(e.seq);});assert.deepEqual(seen,sequential);
 const archive=capture.sources[2]!,bytes=fs.readFileSync(archive.file),bad=Buffer.from(bytes);bad[0]^=1;fs.writeFileSync(archive.file,bad);await assert.rejects(j.visitHistory(()=>{},undefined,undefined,{capture,prefetch:4}));fs.writeFileSync(archive.file,bytes);
 const afterRepair:number[]=[];await j.visitHistory(e=>{afterRepair.push(e.seq);},undefined,undefined,{prefetch:4});assert.deepEqual(afterRepair,seen);
 j.append('message.recorded','pm','pm',0,{role:'user',content:'CAPTURE_PREFIX'});const boundary=j.sequence();let active=0,peak=0;const stat=fs.promises.stat;
 const asynchronous=mock.method(fs.promises,'stat',(async(...args:any[])=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setImmediate(r));return await (stat as any)(...args);}finally{active--;}}) as any);
 let concurrent;try{const pending=j.historySourcesAsync(4);j.append('message.recorded','pm','pm',0,{role:'user',content:'CONCURRENT_APPEND'});concurrent=await pending;}finally{asynchronous.mock.restore();}
 assert.ok(peak>1&&peak<=4);assert.equal(concurrent!.seq,boundary.seq);const capturedMessages:string[]=[];await j.visitHistory(e=>{if(e.kind==='message.recorded')capturedMessages.push(e.data.content);},undefined,undefined,{capture:concurrent!,prefetch:4});assert.equal(capturedMessages.at(-1),'CAPTURE_PREFIX');assert.equal((await transcriptPage(folder)).rows.at(-1)?.text,'CONCURRENT_APPEND');
});

test('reused readers perform one fresh catalog pass, skip old data and revalidate in-place source changes and restore boundaries',async()=>{
 const {folder}=await fixture('reader');const cold=await transcriptPage(folder,undefined,20);assert.ok(cold.index!.readBatches!>0);assert.ok(cold.index!.maxPrefetch!<=4);
 const archives=fs.readdirSync(path.join(folder,'.spawn/events/memory')).filter(n=>n.endsWith('.mem.gz'));
 const warm=await transcriptPage(folder,cold.nextBefore,20);assert.ok(['watched','full'].includes(warm.index!.metadataMode!));assert.ok(warm.index!.metadataChecks!<=archives.length);assert.equal(warm.index?.visited,0);assert.equal(warm.index?.readBatches,0);assert.equal(warm.index?.projectionBytesRead,0);
 const file=path.join(folder,'.spawn/events/memory',archives[0]!),bytes=fs.readFileSync(file),bad=Buffer.from(bytes);bad[0]^=1;fs.writeFileSync(file,bad);await assert.rejects(transcriptPage(folder),/校验/);fs.writeFileSync(file,bytes);assert.ok((await transcriptPage(folder)).rows.length);
 const marker=path.join(folder,'.spawn/restore-transaction.json');fs.writeFileSync(marker,'{}');await assert.rejects(transcriptPage(folder),/校验/);fs.unlinkSync(marker);assert.ok((await transcriptPage(folder)).rows.length);
 await closeTranscriptReaders(folder);const restarted=await transcriptPage(folder);assert.equal(restarted.index?.visited,0);assert.equal(restarted.index?.mode,'incremental');
});

test('closing an active reader rejects pending work safely; idle readers do not delay process exit',async()=>{
 const {folder,j}=await fixture('lifecycle'),state=j.current('pm');const pending=transcriptPage(folder),rejection=assert.rejects(pending,/关闭/);await closeTranscriptReaders(folder);await rejection;assert.deepEqual(new SessionJournal(folder).current('pm'),state);assert.ok((await transcriptPage(folder)).rows.length);await closeTranscriptReaders(folder);
 const module=pathToFileURL(path.resolve('src/session/Transcript.ts')).href,tsx=pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
 const child=await exec(process.execPath,['--import',tsx,'--input-type=module','-e',`const {transcriptPage}=await import(${JSON.stringify(module)});const p=await transcriptPage(${JSON.stringify(folder)});console.log('IDLE_EXIT_OK',p.rows.length);`],{env:process.env,timeout:15000});assert.match(child.stdout,/IDLE_EXIT_OK/);
});
