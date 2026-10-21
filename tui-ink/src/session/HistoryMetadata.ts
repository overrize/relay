import fs from 'node:fs';
import path from 'node:path';
/** Directory notifications are a bounded-freshness optimization, never a durable
 * integrity certificate. Unsupported/lost watches force a full metadata pass. */
export class HistoryMetadata {
 private cache=new Map<string,fs.Stats>();private pending=new Set<string>();private watches=new Map<string,{watch:fs.FSWatcher;identity:string;healthy:boolean}>();private epoch=0;private fullAt=0;
 mode:'full'|'watched'='full';readonly windowMs=5000;
 remember(file:string,stat:fs.Stats){this.cache.set(file,stat);}
 forget(file:string){this.cache.delete(file);}
 invalidate(){this.epoch++;this.cache.clear();this.fullAt=0;}
 async prepare(directories:string[]){
  let healthy=true;
  for(const directory of directories){
   let stat:fs.Stats;try{stat=await fs.promises.stat(directory);}catch(e:any){if(e.code!=='ENOENT')throw e;const old=this.watches.get(directory);if(old){old.watch.close();this.watches.delete(directory);this.invalidate();}continue;}
   const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,old=this.watches.get(directory);
   if(!old||old.identity!==identity){old?.watch.close();this.invalidate();try{
    const record={watch:undefined as unknown as fs.FSWatcher,identity,healthy:true};
    record.watch=fs.watch(directory,{persistent:false},(_event,name)=>{if(!name)this.invalidate();else{const file=path.join(directory,String(name));if(this.cache.has(file)||this.pending.has(file)){this.epoch++;this.cache.delete(file);}}});
    record.watch.on('error',()=>{record.healthy=false;this.invalidate();});record.watch.on('close',()=>{record.healthy=false;this.invalidate();});this.watches.set(directory,record);
   }catch{healthy=false;}}
   if(this.watches.get(directory)?.healthy!==true)healthy=false;
  }
  // Allow already queued filesystem notifications to invalidate the cache before
  // deciding whether this request can reuse metadata.
  await new Promise<void>(r=>setImmediate(r));
  const now=Date.now();this.mode=!healthy||!this.fullAt||now<this.fullAt||now-this.fullAt>=this.windowMs?'full':'watched';
  if(this.mode==='full'){this.cache.clear();this.fullAt=healthy?now:0;}
 }
 async stat(file:string,onCheck:()=>void){const cached=this.cache.get(file);if(cached)return cached;const epoch=this.epoch;onCheck();this.pending.add(file);try{const stat=await fs.promises.stat(file);if(epoch===this.epoch)this.cache.set(file,stat);return stat;}finally{this.pending.delete(file);}}
 close(){for(const w of this.watches.values())w.watch.close();this.watches.clear();this.invalidate();}
}
