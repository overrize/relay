import {parentPort,workerData} from 'node:worker_threads';
import {SessionJournal} from './Journal.js';
import {AuditIndex} from './AuditIndex.js';
export interface TranscriptPage {rows:{seq:number;role:string;text:string;revision:number}[];nextBefore?:number;through:number;throughAt:number;index?:{mode:string;visited:number;retained:boolean;projectionBytesRead:number}}
async function page(rebuild=false):Promise<TranscriptPage>{
 const maxBytes=Number(process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES??256*1024*1024),index=new AuditIndex(workerData.root,{directory:'transcript-cache',maxBytes});
 try{
  index.initMessages();const journal=new SessionJournal(workerData.root,{automatic:false,cacheCheckpoint:true}),captured=journal.historySources(),loaded=rebuild?undefined:await index.load(captured),cached=loaded?.state?.kind==='transcript-v2'&&loaded.state.count===index.messageCount()?loaded:undefined;
  if(!cached){index.reset();index.clearMessages();}
  const anchors=new Map<number,string>(cached?.manifest.filter(s=>s.lastHash).map(s=>[s.to,s.lastHash!])??[]);
  let throughAt=cached?.state?.throughAt??0,visited=0;
  const boundary=await journal.visitHistory(entry=>{
   visited++;throughAt=Math.max(throughAt,entry.ts);if(entry.agent!=='pm'||entry.kind!=='message.recorded')return;
   const content=String(entry.data.content),text=content.length<=24000?content:content.slice(0,12000)+'\n[长内容已截取，完整事件保留在账本]\n'+content.slice(-12000);
   index.message({seq:entry.seq,role:String(entry.data.role),text,revision:entry.revision});
  },cached?{seq:cached.seq,lastHash:cached.lastHash}:undefined,(seq,hash)=>anchors.set(seq,hash));
  const stable=boundary.seq===captured.seq&&boundary.lastHash===captured.lastHash;
  if(stable&&(!cached||visited||cached.rebasedSources||cached.upgraded))await index.save({...captured,...boundary},{throughAt,kind:'transcript-v2',count:index.messageCount()},anchors);
  const rows=index.messages<TranscriptPage['rows'][number]>(workerData.before,workerData.limit+1),more=rows.length>workerData.limit;if(more)rows.pop();rows.reverse();
  const retained=stable?index.commit().retained:false;
  return {rows,nextBefore:more?rows[0]?.seq:undefined,through:boundary.seq,throughAt,index:{mode:cached?'incremental':'rebuilt',visited,retained,projectionBytesRead:journal.stats.bytesRead}};
 }finally{index.close();}
}
try{
 let result:TranscriptPage|undefined,rebuild=false;
 for(let attempt=0;;attempt++)try{result=await page(rebuild);break;}catch(error){const invalid=/Transcript cache row integrity|JSON|Unexpected token/i.test(String(error));if(attempt>=2||!invalid&&!/busy|locked|lock unavailable|boundary changed|ENOENT/i.test(String(error)))throw error;rebuild||=invalid;await new Promise(r=>setTimeout(r,30*(attempt+1)));}
 parentPort!.postMessage({page:result});
}catch{parentPort!.postMessage({error:'历史或分页索引未能校验；请检查完整性或并发写入后重试。'});}
