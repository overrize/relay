// Reproducible, offline retained-history and renderer benchmark. All artifacts stay on the workspace drive.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {SessionJournal} from '../dist/session/Journal.js';
import {transcriptPage} from '../dist/session/Transcript.js';
import {VirtualTranscript} from '../dist/tui/native/VirtualTranscript.js';
const count=Number(process.argv[2]??3000);if(!Number.isSafeInteger(count)||count<200||count>100000)throw Error('count must be 200..100000');
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/transcript26-benchmark-'));
const j=new SessionJournal(root,{automatic:false,segmentBytes:65536});j.bind('pm','Leader');j.append('requirement.changed','pm','pm',1,{text:'BENCHMARK_CURRENT'});
for(let i=0;i<count;i++)j.append('message.recorded','pm','pm',1,{role:i%2?'assistant':'user',content:`ARCHIVE_MESSAGE_${i} `+'历史记录，作为只读证据。 '.repeat(150)});
const maintenance=await j.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:1024*1024*1024});assert.deepEqual(maintenance.errors,[]);
const samples=[];let before;for(let i=0;i<4;i++){const start=performance.now(),page=await transcriptPage(root,before);samples.push({page:i+1,ms:Math.round(performance.now()-start),rows:page.rows.length,...page.index});if(i)assert.equal(page.index.visited,0);before=page.nextBefore;}
const view=new VirtualTranscript(()=>22,()=>{}),texts=Array.from({length:10000},(_,i)=>`VIRTUAL_${i} 中文🙂\n多行历史`);view.setBlocks(texts);view.render(100);const measured=view.stats.measuredBlocks,start=performance.now();for(let i=0;i<1000;i++){if(i%20===0)view.scrollBy(-1);view.render(100);}const renderMs=Math.round(performance.now()-start);assert.equal(view.stats.measuredBlocks,measured);assert.ok(view.stats.cachedBlocks<=24);
const report={root,messages:count,compactedSegments:maintenance.compactedSegments,protectedArchiveBytes:maintenance.archiveBytes,samples,virtual:{messages:10000,frames:1000,ms:renderMs,...view.stats}};fs.writeFileSync(path.join(root,'benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
