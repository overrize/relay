import {Worker} from 'node:worker_threads';
import type {TranscriptPage} from './TranscriptWorker.js';
export function transcriptPage(root:string,before=Number.MAX_SAFE_INTEGER,limit=80):Promise<TranscriptPage>{
 if(!Number.isSafeInteger(before)||before<1)throw Error('INVALID_HISTORY_CURSOR');
 if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('INVALID_HISTORY_LIMIT');
 const source=import.meta.url.endsWith('.ts'),entry=new URL(source?'./TranscriptWorker.ts':'./TranscriptWorker.js',import.meta.url);
 const target=source?new URL('data:text/javascript,'+encodeURIComponent(`import {register} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};register();await import(${JSON.stringify(entry.href)});`)):entry;
 return new Promise((resolve,reject)=>{
  const worker=new Worker(target,{workerData:{root,before,limit:Math.max(1,Math.min(200,limit))},stdout:true,stderr:true,...(source?{execArgv:[]}:{})});worker.stdout.resume();worker.stderr.resume();let response:any;
  worker.once('message',message=>response=message);worker.once('error',reject);worker.once('exit',code=>{if(code!==0||!response)reject(Error('历史读取进程未完成'));else if(response.error)reject(Error(response.error));else resolve(response.page);});
 });
}
