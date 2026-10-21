import {parentPort,workerData} from 'node:worker_threads';
import {SessionJournal} from './Journal.js';
import {AuditIndex} from './AuditIndex.js';
import fs from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';
export interface TranscriptPage {rows:{seq:number;role:string;text:string;revision:number}[];nextBefore?:number;through:number;throughAt:number;index?:{mode:string;visited:number;retained:boolean;projectionBytesRead:number;metadataChecks?:number;lookupSteps?:number;readBatches?:number;maxPrefetch?:number;timings?:Record<string,number>}}
let journal:SessionJournal|undefined;
async function page(request:{before:number;limit:number;maxBytes:number},rebuild=false):Promise<TranscriptPage>{
 if(fs.existsSync(path.join(workerData.root,'.spawn/restore-transaction.json')))throw Error('Restore in progress');
 const started=performance.now(),index=new AuditIndex(workerData.root,{directory:'transcript-cache',maxBytes:request.maxBytes});
 try{
  index.initMessages();const previous=journal?.stats,stats={bytesRead:previous?.bytesRead??0,sourceMetadataChecks:previous?.sourceMetadataChecks??0,sourceLookupSteps:previous?.sourceLookupSteps??0,historyBatches:previous?.historyBatches??0};journal??=new SessionJournal(workerData.root,{automatic:false,cacheCheckpoint:true});const captured=await journal.historySourcesAsync(),catalogAt=performance.now(),loaded=rebuild?undefined:await index.load(captured),cached=loaded?.state?.kind==='transcript-v2'&&loaded.state.count===index.messageCount()?loaded:undefined,validatedAt=performance.now();
  if(!cached){index.reset();index.clearMessages();}
  const anchors=new Map<number,string>(cached?.manifest.filter(s=>s.lastHash).map(s=>[s.to,s.lastHash!])??[]);
  let throughAt=cached?.state?.throughAt??0,visited=0;
  const boundary=await journal.visitHistory(entry=>{
   visited++;throughAt=Math.max(throughAt,entry.ts);if(entry.agent!=='pm'||entry.kind!=='message.recorded')return;
   const content=String(entry.data.content),text=content.length<=24000?content:content.slice(0,12000)+'\n[长内容已截取，完整事件保留在账本]\n'+content.slice(-12000);
   index.message({seq:entry.seq,role:String(entry.data.role),text,revision:entry.revision});
  },cached?{seq:cached.seq,lastHash:cached.lastHash}:undefined,(seq,hash)=>anchors.set(seq,hash),{capture:captured,prefetch:4});
  const replayAt=performance.now();
  const stable=boundary.seq===captured.seq&&boundary.lastHash===captured.lastHash;
  if(stable&&(!cached||visited||cached.rebasedSources||cached.upgraded))await index.save({...captured,...boundary},{throughAt,kind:'transcript-v2',count:index.messageCount()},anchors);
  const rows=index.messages<TranscriptPage['rows'][number]>(request.before,request.limit+1),more=rows.length>request.limit;if(more)rows.pop();rows.reverse();
  const retained=stable?index.commit().retained:false;
  return {rows,nextBefore:more?rows[0]?.seq:undefined,through:boundary.seq,throughAt,index:{mode:cached?'incremental':'rebuilt',visited,retained,projectionBytesRead:journal.stats.bytesRead-stats.bytesRead,metadataChecks:journal.stats.sourceMetadataChecks-stats.sourceMetadataChecks,lookupSteps:journal.stats.sourceLookupSteps-stats.sourceLookupSteps,readBatches:journal.stats.historyBatches-stats.historyBatches,maxPrefetch:journal.stats.historyBatches===stats.historyBatches?0:journal.stats.maxPrefetch,timings:{catalogMs:Math.round(catalogAt-started),validationMs:Math.round(validatedAt-catalogAt),replayMs:Math.round(replayAt-validatedAt),publishMs:Math.round(performance.now()-replayAt)}}};
 }finally{index.close();}
}
async function run(request:{id:number;before:number;limit:number;maxBytes:number}){try{
 let result:TranscriptPage|undefined,rebuild=false;
 for(let attempt=0;;attempt++)try{result=await page(request,rebuild);break;}catch(error){const invalid=/Transcript cache row integrity|JSON|Unexpected token/i.test(String(error));if(attempt>=2||!invalid&&!/busy|locked|lock unavailable|boundary changed|ENOENT/i.test(String(error)))throw error;rebuild||=invalid;await new Promise(r=>setTimeout(r,30*(attempt+1)));}
 parentPort!.postMessage({id:request.id,page:result});
}catch{journal=undefined;parentPort!.postMessage({id:request.id,error:'历史或分页索引未能校验；请检查完整性或并发写入后重试。'});}}
let queue=Promise.resolve();parentPort!.on('message',request=>{queue=queue.then(()=>run(request));});
