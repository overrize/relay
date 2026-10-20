import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {DatabaseSync,type StatementSync} from "node:sqlite";
import {digest,yieldIO,decodeArchive,parseEvents} from "./Storage.js";
import type {SessionJournal} from "./Journal.js";
import type {AuditFilter,AuditRow} from "./Audit.js";

type Boundary=ReturnType<SessionJournal["historySources"]>;
type Manifest=Boundary["sources"][number]&{contentHash:string;lastHash?:string};
const queues=new Map<string,Promise<unknown>>();
/** Serialize same-process queries; a separate process gets an explicit busy error.
 * This database is disposable and contains sanitized accounting rows only. */
export async function withAuditIndex<T>(root:string,use:(index:AuditIndex)=>Promise<T>):Promise<T>{
  const key=path.resolve(root),previous=queues.get(key)??Promise.resolve();
  const next=previous.catch(()=>{}).then(async()=>{const index=new AuditIndex(key);try{return await use(index);}finally{index.close();}});
  queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}
}
async function prefixHash(file:string,size:number){
  const fd=await fs.promises.open(file,"r"),h=createHash("sha256"),buffer=Buffer.alloc(Math.min(size,65536));
  try{for(let offset=0;offset<size;){const {bytesRead}=await fd.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!bytesRead)throw Error("Audit source truncated");h.update(buffer.subarray(0,bytesRead));offset+=bytesRead;await yieldIO();}return h.digest("hex");}finally{await fd.close();}
}
async function tailAnchor(file:string,size:number,through:number){
  const fd=await fs.promises.open(file,"r");let count=Math.min(size,8192);
  try{while(true){const bytes=Buffer.alloc(count);await fd.read(bytes,0,count,size-count);
    if(count===size||bytes.subarray(0,-1).lastIndexOf(10)>=0){const last=JSON.parse(bytes.toString("utf8").trimEnd().split("\n").at(-1)!);if(last.seq!==through||!/^[a-f0-9]{64}$/.test(last.hash))throw Error("Invalid cached source anchor");return last.hash as string;}
    count=Math.min(size,count*2);await yieldIO();
  }}finally{await fd.close();}
}
export class AuditIndex{
  private db:DatabaseSync;
  private maxBytes:number;
  private statements=new Map<string,StatementSync>();
  private statement(sql:string){let statement=this.statements.get(sql);if(!statement){statement=this.db.prepare(sql);this.statements.set(sql,statement);}return statement;}
  constructor(root:string){
    this.maxBytes=Number(process.env.SPAWN_AUDIT_INDEX_MAX_BYTES??256*1024*1024);
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<0)throw Error("SPAWN_AUDIT_INDEX_MAX_BYTES must be a nonnegative integer");
    const directory=path.join(root,".spawn","audit-cache");fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,"index.sqlite");
    const open=()=>{const db=new DatabaseSync(file);try{db.exec("PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS rows(seq INTEGER PRIMARY KEY, model TEXT, task TEXT, json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS rows_model ON rows(model,seq); CREATE INDEX IF NOT EXISTS rows_task ON rows(task,seq); CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, json TEXT NOT NULL, unpriced INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS requests_unpriced ON requests(unpriced);");return db;}catch(e){db.close();throw e;}};
    try{this.db=open();}catch(e:any){if(!/malformed|not a database/i.test(String(e)))throw e;fs.unlinkSync(file);this.db=open();}
    try{this.db.exec("BEGIN IMMEDIATE");}catch(e){this.db.close();throw Error("Audit index busy; retry after the other audit finishes",{cause:e});}
  }
  async load(boundary:Boundary):Promise<{state:any;seq:number;lastHash:string;manifest:Manifest[];rebasedSources:number;upgraded:boolean}|undefined>{
    const stored=this.statement("SELECT json,hash FROM meta WHERE id=1").get() as {json:string;hash:string}|undefined;
    try{
      if(!stored)return;
      const value=JSON.parse(stored.json);
      if(![1,2].includes(value.version)||digest(value)!==stored.hash||value.seq>boundary.seq) return;
      if(value.seq===boundary.seq&&value.lastHash!==boundary.lastHash)return;
      const sources=new Map(boundary.sources.map(s=>[s.key,s])),byStart=new Map(boundary.sources.map(s=>[s.from,s]));
      let previousHash="",rebasedSources=0;
      for(const old of value.manifest as Manifest[]){
        let current=sources.get(old.key);
        if(current&&current.from===old.from&&current.to>=old.to&&current.size>=old.size&&current.fingerprint===old.fingerprint){
          if(!old.lastHash){old.lastHash=current.archive?.lastHash??(old.to===value.seq?value.lastHash:await tailAnchor(current.file,old.size,old.to));value.upgraded=true;}
          previousHash=old.lastHash!;continue;
        }
        if(!old.lastHash&&old.to===value.seq)old.lastHash=value.lastHash;
        current=byStart.get(old.from);
        if(current&&current.to<old.to)return;
        if(!current)return;
        if(!current.archive&&old.contentHash&&current.size>=old.size&&await prefixHash(current.file,old.size)===old.contentHash){previousHash=old.lastHash??value.lastHash;rebasedSources++;continue;}
        if(!old.lastHash)return;
        if(current.archive){
          if(current.to!==old.to||current.archive.lastHash!==old.lastHash)return;
          await decodeArchive(await fs.promises.readFile(current.file),current.archive);
        }else{
          const fd=await fs.promises.open(current.file,"r");let bytes:Buffer;
          try{bytes=Buffer.alloc(old.size);let offset=0;while(offset<bytes.length){const r=await fd.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)return;offset+=r.bytesRead;}}finally{await fd.close();}
          let through=old.from-1;
          for(const entry of parseEvents(bytes)){
            const {hash:actual,...body}=entry;
            if(entry.seq!==through+1||createHash("sha256").update(previousHash+JSON.stringify(body)).digest("hex")!==actual)return;
            previousHash=actual;through=entry.seq;if(through%32===0)await yieldIO();
          }
          if(through!==old.to||previousHash!==old.lastHash)return;
        }
        previousHash=old.lastHash;rebasedSources++;
      }
      value.rebasedSources=rebasedSources;
      return value;
    }catch{return;}
  }
  reset(rebuild=false){
    if(rebuild)this.db.exec("DROP INDEX IF EXISTS rows_model; DROP INDEX IF EXISTS rows_task; DROP INDEX IF EXISTS requests_unpriced;");
    this.db.exec("DELETE FROM meta; DELETE FROM rows; DELETE FROM requests;");
  }
  finishRebuild(){this.db.exec("CREATE INDEX IF NOT EXISTS rows_model ON rows(model,seq); CREATE INDEX IF NOT EXISTS rows_task ON rows(task,seq); CREATE INDEX IF NOT EXISTS requests_unpriced ON requests(unpriced);");}
  seen(id:string){return !!this.statement("SELECT 1 FROM requests WHERE id=?").get(id);}
  request(id:string){const value=this.statement("SELECT json FROM requests WHERE id=?").get(id) as {json:string}|undefined;return value?JSON.parse(value.json) as AuditRow:undefined;}
  row(row:AuditRow){this.statement("INSERT OR REPLACE INTO rows VALUES(?,?,?,?)").run(row.seq,row.model??null,row.task??null,JSON.stringify(row));if(row.kind==="request"||row.kind==="settlement")this.statement("INSERT OR REPLACE INTO requests VALUES(?,?,?)").run(row.id,JSON.stringify(row),row.billing!=="subscription"&&!row.pricingKnown?1:0);}
  page(filter:AuditFilter){
    const clauses:string[]=[],args:(string|number)[]=[];
    for(const key of ["model","task"] as const)if(filter[key]){clauses.push(`${key}=?`);args.push(filter[key]!);}
    if(filter.before){clauses.push("seq<?");args.push(filter.before);}
    args.push((filter.limit??40)+1);
    const result=this.statement(`SELECT json FROM rows ${clauses.length?"WHERE "+clauses.join(" AND "):""} ORDER BY seq DESC LIMIT ?`).all(...args) as {json:string}[];
    const rows=result.map(r=>JSON.parse(r.json) as AuditRow),more=rows.length>(filter.limit??40);if(more)rows.pop();
    return {rows,nextBefore:more?rows.at(-1)?.seq:undefined};
  }
  *unpriced(){for(const r of this.statement("SELECT json FROM requests WHERE unpriced=1").iterate() as Iterable<{json:string}>){const row=JSON.parse(r.json) as AuditRow;if(row.billing!=="subscription"&&!row.pricingKnown)yield row;}}
  async save(boundary:Boundary,state:unknown,anchors:Map<number,string>){
    const manifest:Manifest[]=[];
    for(const source of boundary.sources)manifest.push({...source,lastHash:anchors.get(source.to),contentHash:source.key==="active"?await prefixHash(source.file,source.size):""});
    const value={version:2,seq:boundary.seq,lastHash:boundary.lastHash,manifest,state};
    this.statement("INSERT OR REPLACE INTO meta VALUES(1,?,?)").run(JSON.stringify(value),digest(value));
  }
  commit(){
    const pages=this.statement("PRAGMA page_count").get() as {page_count:number},size=this.statement("PRAGMA page_size").get() as {page_size:number};
    const bytes=pages.page_count*size.page_size,retained=bytes<=this.maxBytes;
    if(!retained)this.reset();
    this.db.exec("COMMIT");
    if(!retained){try{this.db.exec("VACUUM");}catch(e){if(!/locked|busy/i.test(String(e)))throw e;}}
    return {retained,bytes,maxBytes:this.maxBytes};
  }
  close(){this.db.close();}
}
