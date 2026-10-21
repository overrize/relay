import path from 'node:path';
import {Worker} from 'node:worker_threads';
import type {TranscriptPage} from './TranscriptWorker.js';
interface Reader {worker:Worker;pending:Map<number,{resolve:(p:TranscriptPage)=>void;reject:(e:Error)=>void}>;timer?:ReturnType<typeof setTimeout>;closed:boolean}
const readers=new Map<string,Reader>();let requestId=0;
async function closeReader(root:string,reader:Reader){if(reader.closed)return;reader.closed=true;if(readers.get(root)===reader)readers.delete(root);clearTimeout(reader.timer);for(const p of reader.pending.values())p.reject(Error('历史读取已关闭'));reader.pending.clear();await reader.worker.terminate();}
export async function closeTranscriptReaders(root?:string){await Promise.allSettled([...readers].filter(([key])=>!root||key===path.resolve(root)).map(([key,reader])=>closeReader(key,reader)));}
function createReader(root:string){
 if(readers.size>=4){const idle=[...readers].find(([,r])=>!r.pending.size);if(idle)void closeReader(...idle);else throw Error('历史读取线程已忙，请稍后重试');}
 const source=import.meta.url.endsWith('.ts'),entry=new URL(source?'./TranscriptWorker.ts':'./TranscriptWorker.js',import.meta.url);
 const target=source?new URL('data:text/javascript,'+encodeURIComponent(`import {register} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};register();await import(${JSON.stringify(entry.href)});`)):entry;
 const worker=new Worker(target,{workerData:{root},execArgv:['--no-warnings']}),reader:Reader={worker,pending:new Map(),closed:false};
 readers.set(root,reader);
 const failed=()=>{for(const p of reader.pending.values())p.reject(Error('历史读取进程未完成'));reader.pending.clear();reader.closed=true;clearTimeout(reader.timer);if(readers.get(root)===reader)readers.delete(root);};
 worker.once('error',failed);worker.once('exit',failed);
 worker.on('message',message=>{const p=reader.pending.get(message.id);if(!p)return;reader.pending.delete(message.id);if(message.error)p.reject(Error(message.error));else p.resolve(message.page);
  if(!reader.pending.size&&!reader.closed){reader.worker.unref();reader.timer=setTimeout(()=>{void closeReader(root,reader);},30000);reader.timer.unref();}
 });return reader;
}
export function transcriptPage(root:string,before=Number.MAX_SAFE_INTEGER,limit=80):Promise<TranscriptPage>{
 if(!Number.isSafeInteger(before)||before<1)throw Error('INVALID_HISTORY_CURSOR');if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('INVALID_HISTORY_LIMIT');
 const key=path.resolve(root),reader=readers.get(key)??createReader(key),id=++requestId;clearTimeout(reader.timer);reader.worker.ref();
 return new Promise((resolve,reject)=>{reader.pending.set(id,{resolve,reject});try{reader.worker.postMessage({id,before,limit,maxBytes:Number(process.env.SPAWN_TRANSCRIPT_INDEX_MAX_BYTES??256*1024*1024)});}catch{reader.pending.delete(id);reject(Error('历史读取请求未发送'));void closeReader(key,reader);}});
}
