import {parentPort,workerData} from 'node:worker_threads';
import {SessionJournal} from './Journal.js';
export interface TranscriptPage {rows:{seq:number;role:string;text:string;revision:number}[];nextBefore?:number;through:number;throughAt:number}
try{
 const journal=new SessionJournal(workerData.root,{automatic:false,cacheCheckpoint:false}),rows:TranscriptPage['rows']=[];
 let throughAt=0;const boundary=await journal.visitHistory(entry=>{
  throughAt=Math.max(throughAt,entry.ts);
  if(entry.agent!=='pm'||entry.kind!=='message.recorded'||entry.seq>=workerData.before)return;
  const content=String(entry.data.content),text=content.length<=24000?content:content.slice(0,12000)+'\n[长内容已截取，完整事件保留在账本]\n'+content.slice(-12000);
  rows.push({seq:entry.seq,role:String(entry.data.role),text,revision:entry.revision});if(rows.length>workerData.limit+1)rows.shift();
 });
 const more=rows.length>workerData.limit;if(more)rows.shift();parentPort!.postMessage({page:{rows,nextBefore:more?rows[0]?.seq:undefined,through:boundary.seq,throughAt}});
}catch{parentPort!.postMessage({error:'历史完整性校验失败；未显示不完整历史，请重试或检查归档。'});}
