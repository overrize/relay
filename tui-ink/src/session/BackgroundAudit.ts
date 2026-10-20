import path from "node:path";
import {Worker} from "node:worker_threads";
import type {AuditFilter,auditReport} from "./Audit.js";
/** Keep projection replay, SQLite writes and compaction off the PM event loop. */
const queues=new Map<string,Promise<unknown>>();
export function backgroundAuditReport(root=process.cwd(),filter:AuditFilter={}):ReturnType<typeof auditReport>{
  const key=path.resolve(root),previous=queues.get(key)??Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{for(let attempt=0;;attempt++){try{return await runAudit(key,filter);}catch(e:any){if(!e.busy||attempt>=2)throw e;await new Promise(r=>setTimeout(r,25*(attempt+1)));}}});queues.set(key,next);
  return next.finally(()=>{if(queues.get(key)===next)queues.delete(key);});
}
function runAudit(root:string,filter:AuditFilter):ReturnType<typeof auditReport>{
  const source=import.meta.url.endsWith(".ts"),entry=new URL(source?"./AuditWorker.ts":"./AuditWorker.js",import.meta.url);
  const target=source?new URL("data:text/javascript,"+encodeURIComponent(`import {register} from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))};register();await import(${JSON.stringify(entry.href)});`)):entry;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(target,{workerData:{root,filter},stdout:true,stderr:true,...(source?{execArgv:[]}:{})});
    worker.stdout.resume();worker.stderr.resume();
    let reported=false;
    worker.once("message",message=>{reported=true;if(message.error)reject(Object.assign(Error(message.error),{busy:message.busy}));else resolve(message.report);});
    worker.once("error",reject);worker.once("exit",code=>{if(code!==0||!reported)reject(Error("Audit worker exited before completion"));});
  });
}
