import {parentPort,workerData} from 'node:worker_threads';
import {HistoryMetadata} from './HistoryMetadata.js';
import {SessionJournal} from './Journal.js';
import {AuditIndex} from './AuditIndex.js';
import fs from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';
export interface TranscriptPage {
 rows:{seq:number;role:string;text:string;revision:number}[];nextBefore?:number;through:number;throughAt:number;
 index?:{mode:string;visited:number;retained:boolean;projectionBytesRead:number;metadataChecks?:number;lookupSteps?:number;readBatches?:number;maxPrefetch?:number;streamedArchives?:number;metadataMode?:string;validationWindowMs?:number;resumedFrom?:number;checkpoints?:number;checkpointedThrough?:number;checkpointRetained?:boolean;timings?:Record<string,number>};
}
interface Request {id:number;before:number;limit:number;maxBytes:number;batchSources:number}
let journal:SessionJournal|undefined;const metadata=new HistoryMetadata();
async function page(request:Request,rebuild=false):Promise<TranscriptPage>{
 if(fs.existsSync(path.join(workerData.root,'.spawn/restore-transaction.json')))throw Error('Restore in progress');
 const started=performance.now();
 const progress=(phase:string,visited:number,through:number,extra:Record<string,number>={})=>parentPort!.postMessage({id:request.id,progress:{phase,visited,through,...extra}});
 progress('校验来源',0,0);
 const index=new AuditIndex(workerData.root,{directory:'transcript-cache',maxBytes:request.maxBytes});
 try{
  index.initMessages();
  const previous=journal?.stats,stats={bytesRead:previous?.bytesRead??0,sourceMetadataChecks:previous?.sourceMetadataChecks??0,sourceLookupSteps:previous?.sourceLookupSteps??0,historyBatches:previous?.historyBatches??0,archiveStreams:previous?.archiveStreams??0};
  if(!journal){const directory=path.join(workerData.root,'.spawn/events');await metadata.prepare([path.join(directory,'memory'),path.join(directory,'segments')]);journal=new SessionJournal(workerData.root,{automatic:false,cacheCheckpoint:true,historyMetadata:metadata});}
  const captured=await journal.historySourcesAsync(8,metadata,rebuild?[]:index.messages<{seq:number}>(request.before,request.limit+1).map(r=>r.seq)),catalogAt=performance.now();
  const loaded=rebuild?undefined:await index.load(captured);
  const cached=loaded&&['transcript-v2','transcript-build-v1'].includes(loaded.state?.kind)&&loaded.state.count===index.messageCount()?loaded:undefined;
  const validatedAt=performance.now(),resumedFrom=cached?.state.kind==='transcript-build-v1'?cached.seq:0;
  if(!cached)index.reset();
  const anchors=new Map<number,string>(cached?.manifest.filter(s=>s.lastHash).map(s=>[s.to,s.lastHash!])??[]);
  let throughAt=cached?.state?.throughAt??0,visited=0,lastProgress=0,batchSources=0,lastCheckpointAt=performance.now(),prefixEnd=0,checkpoints=0,checkpointedThrough=resumedFrom,checkpointRetained=request.maxBytes>0;
  const phase=resumedFrom?'续建索引':cached?'增量读取':'重建索引';
  progress(phase,0,captured.seq,{resumedFrom});
  const boundary=await journal.visitHistory(entry=>{
   visited++;if(performance.now()-lastProgress>=100){lastProgress=performance.now();progress(phase,visited,captured.seq,{resumedFrom});}
   throughAt=Math.max(throughAt,entry.ts);if(entry.agent!=='pm'||entry.kind!=='message.recorded')return;
   const content=String(entry.data.content),text=content.length<=24000?content:content.slice(0,12000)+'\n[长内容已截取，完整事件保留在账本]\n'+content.slice(-12000);
   index.message({seq:entry.seq,role:String(entry.data.role),text,revision:entry.revision});
  },cached?{seq:cached.seq,lastHash:cached.lastHash}:undefined,async(seq,lastHash)=>{
   anchors.set(seq,lastHash);batchSources++;
   if(seq>=captured.seq||!checkpointRetained||(batchSources<request.batchSources&&performance.now()-lastCheckpointAt<250))return;
   while(prefixEnd<captured.sources.length&&captured.sources[prefixEnd]!.to<=seq)prefixEnd++;
   await index.saveBuild({...captured,seq,lastHash,sources:captured.sources.slice(0,prefixEnd)},{kind:'transcript-build-v1',throughAt,count:index.messageCount(),targetSeq:captured.seq},anchors);
   const saved=index.checkpoint();checkpointRetained=saved.retained;
   if(saved.retained){checkpoints++;checkpointedThrough=seq;progress('已保存构建断点',visited,captured.seq,{checkpoint:seq,resumedFrom});}
   else progress('索引配额不足，断点未保存',visited,captured.seq,{checkpoint:checkpointedThrough,resumedFrom});
   batchSources=0;lastCheckpointAt=performance.now();
  },{capture:captured,prefetch:4,streamArchives:true});
  const replayAt=performance.now();
  const stable=boundary.seq===captured.seq&&boundary.lastHash===captured.lastHash;
  if(stable&&(!cached||visited||cached.rebasedSources||cached.upgraded||resumedFrom))await index.save({...captured,...boundary},{throughAt,kind:'transcript-v2',count:index.messageCount()},anchors);
  const rows=index.messages<TranscriptPage['rows'][number]>(request.before,request.limit+1),more=rows.length>request.limit;if(more)rows.pop();rows.reverse();
  const retained=stable?index.commit().retained:false;
  return {rows,nextBefore:more?rows[0]?.seq:undefined,through:boundary.seq,throughAt,index:{mode:resumedFrom?'resumed':cached?'incremental':'rebuilt',visited,retained,resumedFrom,checkpoints,checkpointedThrough,checkpointRetained:checkpointRetained&&retained,projectionBytesRead:journal.stats.bytesRead-stats.bytesRead,metadataChecks:journal.stats.sourceMetadataChecks-stats.sourceMetadataChecks,lookupSteps:journal.stats.sourceLookupSteps-stats.sourceLookupSteps,readBatches:journal.stats.historyBatches-stats.historyBatches,maxPrefetch:journal.stats.historyBatches===stats.historyBatches?0:journal.stats.maxPrefetch,streamedArchives:journal.stats.archiveStreams-stats.archiveStreams,metadataMode:metadata.mode,validationWindowMs:metadata.windowMs,timings:{catalogMs:Math.round(catalogAt-started),validationMs:Math.round(validatedAt-catalogAt),replayMs:Math.round(replayAt-validatedAt),publishMs:Math.round(performance.now()-replayAt)}}};
 }finally{index.close();}
}
async function run(request:Request){try{
 let result:TranscriptPage|undefined,rebuild=false;
 for(let attempt=0;;attempt++)try{result=await page(request,rebuild);break;}catch(error){const invalid=/Transcript cache row integrity|JSON|Unexpected token/i.test(String(error));if(attempt>=2||!invalid&&!/busy|locked|lock unavailable|boundary changed|ENOENT/i.test(String(error)))throw error;rebuild||=invalid;await new Promise(r=>setTimeout(r,30*(attempt+1)));}
 parentPort!.postMessage({id:request.id,page:result});
}catch{journal=undefined;metadata.invalidate();parentPort!.postMessage({id:request.id,error:'历史或分页索引未能校验；请检查完整性或并发写入后重试。'});}}
let queue=Promise.resolve();parentPort!.on('message',request=>{queue=queue.then(()=>run(request));});
