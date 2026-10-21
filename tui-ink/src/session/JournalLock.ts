import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
/** A prepared nonempty directory is atomically renamed into place. Unlike hard
 * links this works on exFAT as well as the Linux/Windows CI filesystems. */
export function prepareJournalLock(file:string,durable:boolean){
 const lock=`${file}.lock`,token=randomUUID(),candidate=`${lock}.${process.pid}.${token}.tmp`;
 let acquired=false;fs.mkdirSync(candidate);
 const remove=(name:string)=>{try{fs.unlinkSync(name);}catch(e:any){if(e.code!=='ENOENT')throw e;}};
 const cleanup=()=>{remove(`${candidate}/owner`);try{fs.rmdirSync(candidate);}catch(e:any){if(e.code!=='ENOENT')throw e;}};
 const owner=()=>{const directory=fs.statSync(lock).isDirectory(),raw=fs.readFileSync(directory?`${lock}/owner`:lock,'utf8'),value=JSON.parse(raw);return {directory,pid:typeof value==='number'?value:value.pid,token:typeof value==='number'?raw:value.token};};
 try{
  const fd=fs.openSync(`${candidate}/owner`,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));if(durable)fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }catch(error){cleanup();throw error;}
 const acquire=()=>{
  if(acquired)throw Error('Journal lock is already held');
  const deadline=Date.now()+1000,wait=new Int32Array(new SharedArrayBuffer(4));
  for(;;){
   try{
    if(fs.existsSync(lock)){const error:any=Error('Lock exists');error.code='EEXIST';throw error;}
    fs.renameSync(candidate,lock);acquired=true;break;
   }catch(error:any){
    if(!fs.existsSync(lock)&&!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;
    let record:ReturnType<typeof owner>|undefined;try{record=owner();}catch{/* Invalid/legacy empty owners remain explicit blockers. */}
    if(record&&Number.isSafeInteger(record.pid)&&record.pid>0){
     try{process.kill(record.pid,0);}catch(e:any){
      if(e.code!=='ESRCH')throw e;
      try{const current=owner();if(current.pid===record.pid&&current.token===record.token){if(current.directory){remove(`${lock}/owner`);try{fs.rmdirSync(lock);}catch(e:any){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}}else remove(lock);}}catch(e:any){if(e.code!=='ENOENT')throw e;}
      if(Date.now()<deadline)continue;
     }
    }
    if(Date.now()>=deadline)throw Error('Another process is writing this session; retry later');
    Atomics.wait(wait,0,0,5);
   }
  }
  return ()=>{if(!acquired)return;const current=owner();if(current.pid!==process.pid||current.token!==token)throw Error('Journal lock owner changed');fs.renameSync(lock,candidate);acquired=false;};
 };
 return {acquire,dispose:()=>{if(acquired)throw Error('Cannot dispose a held journal lock');cleanup();}};
}
export function acquireJournalLock(file:string,durable:boolean){const prepared=prepareJournalLock(file,durable);let release:()=>void;try{release=prepared.acquire();}catch(error){prepared.dispose();throw error;}return ()=>{release();prepared.dispose();};}

