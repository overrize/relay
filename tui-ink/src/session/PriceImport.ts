import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SessionJournal} from './Journal.js';
import {backgroundAuditReport} from './BackgroundAudit.js';
import {priceEndpoint,validatePrice,type PriceDefinition,type PriceRevision} from './Pricing.js';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const fail=(reason:string):never=>{throw Error(`PRICE_IMPORT_${reason}`);};
const keys=['source','issuer','provider','model','baseUrl','currency','unit','inputRate','outputRate','effectiveFrom','effectiveTo','document','documentSha256','usdPerUnit','fxSource','fxDate'];
function csv(text:string){
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i]!;
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closed)fail('CSV_QUOTES');quoted=true;continue;}
    if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';closed=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;if(row.some(Boolean))rows.push(row);row=[];}continue;}
    if(closed)fail('CSV_QUOTES');cell+=c;
  }
  if(quoted)fail('CSV_QUOTES');if(cell||row.length){row.push(cell);rows.push(row);}
  const header=rows.shift()??[];if(!header.length||new Set(header).size!==header.length||header.some(k=>!keys.includes(k)))fail('CSV_HEADER');
  return rows.map(r=>{if(r.length!==header.length)fail('CSV_COLUMNS');return Object.fromEntries(header.map((k,i)=>[k,r[i]]));});
}
function date(value:unknown,optional=false){
  if(optional&&(value===null||value===''))return undefined;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))fail('DATE_TIMEZONE');
  const text=value as string,day=text.slice(0,10),n=Date.parse(text);
  if(Number(text.slice(11,13))>23||Number(text.slice(14,16))>59||Number(text.slice(17,19))>59)fail('DATE_INVALID');
  if(!Number.isFinite(n)||n<0||new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)!==day)fail('DATE_INVALID');return n;
}
function number(v:unknown){if(typeof v!=='number'&&(typeof v!=='string'||!/^\d+(?:\.\d+)?$/.test(v)))fail('RATE_INVALID');const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e9)fail('RATE_INVALID');return n;}
function label(v:unknown){if(typeof v!=='string'||!/^[-\p{L}\p{N}_.:/]{1,120}$/u.test(v))fail('SOURCE_INVALID');return v as string;}
export function readPriceTable(file:string){
  const absolute=fs.realpathSync(file);if(fs.statSync(absolute).size>4*1024*1024)fail('FILE_TOO_LARGE');
  const bytes=fs.readFileSync(absolute),text=bytes.toString('utf8').replace(/^\uFEFF/,'');let rows:any[];
  if(path.extname(absolute).toLowerCase()==='.csv')rows=csv(text);
  else{let data:any;try{data=JSON.parse(text);}catch{fail('JSON_INVALID');}if(data.version!==1||Object.keys(data).some(k=>!['version','prices'].includes(k))||!Array.isArray(data.prices))fail('SCHEMA');rows=data.prices;}
  if(!rows.length||rows.length>5000)fail('ROW_COUNT');const digest=sha(bytes),issuers=new Set<string>(),now=Date.now();
  const prices=rows.map((r,i):PriceDefinition=>{
    try{
    if(!r||typeof r!=='object'||Object.keys(r).some(k=>!keys.includes(k)))fail('UNKNOWN_FIELD');
    const source=label(r.source),issuer=label(r.issuer);if(source.length>111)fail('SOURCE_INVALID');issuers.add(issuer);
    if(!['openai','anthropic'].includes(r.provider)||typeof r.model!=='string'||!/^[-\w./:]{1,160}$/.test(r.model))fail('MODEL');
    let url:URL;try{url=new URL(r.baseUrl);}catch{fail('ENDPOINT');}url=url!;
    if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.search||url.hash||url.hostname.includes('*'))fail('ENDPOINT');
    if(r.unit!=='per-million-tokens'||!['USD','CNY'].includes(r.currency))fail('CURRENCY_UNIT');
    const since=date(r.effectiveFrom)!,expiresAt=date(r.effectiveTo,true);if(expiresAt!==undefined&&expiresAt<=since)fail('INTERVAL');
    let fx:PriceDefinition['fx'];if(r.currency==='CNY'){
      const rate=number(r.usdPerUnit);if(rate===0||!/^\d{4}-\d\d-\d\d$/.test(r.fxDate??''))fail('FX');date(`${r.fxDate}T00:00:00Z`);
      fx={source:label(r.fxSource),date:r.fxDate,usdPerUnit:rate,version:sha(JSON.stringify([r.fxSource,r.fxDate,rate]))};
    }else if([r.usdPerUnit,r.fxSource,r.fxDate].some(v=>v!==undefined&&v!==''))fail('UNEXPECTED_FX');
    let documentHash:string|undefined;
    if(r.document||r.documentSha256){
      if(typeof r.document!=='string'||!r.document||path.isAbsolute(r.document)||!/^([a-f0-9]{64})$/.test(r.documentSha256??''))fail('DOCUMENT');
      const doc=fs.realpathSync(path.resolve(path.dirname(absolute),r.document)),relative=path.relative(path.dirname(absolute),doc);
      if(relative.startsWith('..')||path.isAbsolute(relative)||fs.statSync(doc).size>32*1024*1024)fail('DOCUMENT_PATH');
      documentHash=sha(fs.readFileSync(doc));if(documentHash!==r.documentSha256)fail('DOCUMENT_HASH');
    }
    const inputRate=number(r.inputRate),outputRate=number(r.outputRate),multiplier=fx?.usdPerUnit??1;
    if(inputRate*multiplier>1e9||outputRate*multiplier>1e9)fail('RATE_INVALID');
    return validatePrice({provider:r.provider,model:r.model,endpoint:priceEndpoint(r.provider,url.href),source:`contract:${source}`,since,expiresAt,recordedAt:now,legacy:false,origin:'contract',issuer,importDigest:digest,basis:'contract-estimate',currency:r.currency,inputRate:inputRate*multiplier,outputRate:outputRate*multiplier,components:{inputRate,outputRate},fx,sourceDocumentHash:documentHash??digest,parserVersion:'contract-v1',version:`${digest}:${i}`});
    }catch(error:any){if(/^PRICE_IMPORT_[A-Z_]+$/.test(error.message))error.row=i+1;throw error;}
  });
  return {digest,issuer:[...issuers].sort().join(','),prices};
}
export function trustPriceTable(root:string,file:string,issuer:string){
  const table=readPriceTable(file);if(issuer!==table.issuer)fail('ISSUER_MISMATCH');
  new SessionJournal(root).append('pricing.source_trusted','pm','user',0,{digest:table.digest,issuer:table.issuer,rows:table.prices.length,review:'local-file-review'});
  return {digest:table.digest,issuer:table.issuer,rows:table.prices.length,trust:'local-review-not-vendor-signature'};
}
function conflicts(prices:PriceDefinition[]){
  const scopes=new Map<string,PriceDefinition[]>();for(const p of prices){if(p.origin==='official'||p.retired)continue;const key=JSON.stringify([p.provider,p.model,p.endpoint]);const list=scopes.get(key)??[];list.push(p);scopes.set(key,list);}
  for(const list of scopes.values()){
    list.sort((a,b)=>a.since-b.since);let end=-1,previous:PriceDefinition|undefined;
    for(const p of list){if(p.since<end&&(p.origin==='contract'||previous?.origin==='contract'))fail('INTERVAL_CONFLICT');if((p.expiresAt??Infinity)>end){end=p.expiresAt??Infinity;previous=p;}}
  }
}
export async function importPriceTable(root:string,file:string,options:{apply?:boolean;expect?:string}={}){
  const table=readPriceTable(file),j=new SessionJournal(root),pricingRevision=j.priceRevision(),report=await backgroundAuditReport(root,{limit:1});
  const existing=report.priceDefinitions,imported=existing.filter(p=>p.origin==='contract'&&p.version?.startsWith(`${table.digest}:`));
  if(imported.some(p=>p.retired))fail('RETIRED_BATCH');
  if(imported.length===table.prices.length)return {state:'already-imported',digest:table.digest,rows:imported.length};
  conflicts([...existing,...table.prices]);
  const preview=sha(JSON.stringify([table.digest,pricingRevision]));
  if(options.expect&&options.expect!==preview)fail('PREVIEW_STALE');
  const guard=(state:any)=>{if(state.priceTrust?.[table.digest]!==table.issuer)fail('SOURCE_UNTRUSTED');if((state.pricingRevision??0)!==pricingRevision)fail('CONCURRENT_CHANGE_RETRY');};
  // Guard executes under the same journal writer lock as the single durable batch event.
  if(options.apply)j.append('pricing.imported','pm','user',0,{digest:table.digest,issuer:table.issuer,preview,prices:table.prices},guard);
  else guard({pricingRevision:j.priceRevision(),priceTrust:{[table.digest]:j.trustedPriceTable(table.digest)}});
  return {state:options.apply?'imported':'preview',digest:table.digest,preview,issuer:table.issuer,rows:table.prices.length,prices:table.prices};
}

/** Explicit batch correction; never edits request reservations or settlements. */
export async function revisePriceTable(root:string,target:string,options:{reason:string;file?:string;apply?:boolean;expect?:string;migrate?:boolean}){
  const match=/^([a-f0-9]{64})(?::(0|[1-9]\d{0,3}))?$/.exec(target);
  if(!match)fail('TARGET_DIGEST');
  const digest=match![1]!,single=match![2]!==undefined;
  const reason=options.reason?.trim();if(!reason||reason.length>240||/[\x00-\x1f\x7f]/.test(reason))fail('REVISION_REASON');
  if(options.file!==undefined&&(typeof options.file!=='string'||!options.file))fail('REPLACEMENT_FILE');
  const table=options.file!==undefined?readPriceTable(options.file):undefined,action=table?'replace':'revoke';
  if(options.migrate&&!table)fail('MIGRATION_FILE');
  if(single&&table&&table.prices.length!==1)fail('SINGLE_ROW_REPLACEMENT');
  if(table?.digest===digest)fail('REPLACE_SAME_BATCH');
  const j=new SessionJournal(root),pricingRevision=j.priceRevision(),report=await backgroundAuditReport(root,{limit:1});
  const previous=report.priceDefinitions.filter(p=>p.origin==='contract'&&p.importDigest===digest&&(!single||p.version===target));
  if(!previous.length)fail('TARGET_NOT_FOUND');
  const retired=previous.find(p=>p.retired)?.retired;
  if(retired){
    if(previous.every(p=>p.retired?.id===retired.id)&&retired.action===action&&retired.reason===reason&&retired.replacementDigest===table?.digest&&!!retired.migration===!!options.migrate)return {state:action==='revoke'?'already-revoked':'already-replaced',target,revision:retired.id};
    fail(previous.some(p=>!p.retired)?'PARTIAL_BATCH_USE_ROWS':'TARGET_RETIRED');
  }
  const preview=sha(JSON.stringify([action,target,table?.digest,reason,pricingRevision,!!options.migrate]));
  if(options.expect&&options.expect!==preview)fail('PREVIEW_STALE');
  if(table){
    if(report.priceDefinitions.some(p=>p.origin==='contract'&&p.importDigest===table.digest))fail('REPLACEMENT_ALREADY_KNOWN');
    const scope=(p:PriceDefinition)=>JSON.stringify([p.provider,p.model,p.endpoint]),scopes=(prices:PriceDefinition[])=>JSON.stringify([...new Set(prices.map(scope))].sort());
    if(!options.migrate&&scopes(previous)!==scopes(table.prices))fail('REPLACEMENT_SCOPE');
    if(!options.migrate&&[...new Set(previous.map(p=>p.issuer))].sort().join(',')!==table.issuer)fail('ISSUER_MISMATCH');
    const selected=new Set(previous.map(p=>p.version));
    conflicts([...report.priceDefinitions.filter(p=>!selected.has(p.version)),...table.prices]);
  }
  const guard=(state:any)=>{
    if((state.pricingRevision??0)!==pricingRevision)fail('CONCURRENT_CHANGE_RETRY');
    if(table&&state.priceTrust?.[table.digest]!==table.issuer)fail('SOURCE_UNTRUSTED');
    if(!state.contractPrices?.some((p:PriceDefinition)=>p.importDigest===digest&&(!single||p.version===target)&&!p.retired))fail('TARGET_RETIRED');
  };
  const prices=table?.prices.map(p=>({...p,replacesDigest:digest,...(single?{replacesVersions:[target]}:{})}))??[];
  const data:PriceRevision={action,target,...(single?{targetVersions:[target]}:{}),...(options.migrate?{migration:true}:{}),reason,replacementDigest:table?.digest,prices,preview};
  // Validate current trust/state again inside the same durable writer lock.
  const event=options.apply?j.append('pricing.revised','pm','user',0,data,guard):undefined;
  if(!options.apply){if(j.priceRevision()!==pricingRevision)fail('CONCURRENT_CHANGE_RETRY');if(table&&j.trustedPriceTable(table.digest)!==table.issuer)fail('SOURCE_UNTRUSTED');}
  return {state:event?(action==='revoke'?'revoked':'replaced'):'preview',revision:event?.id,...data,affectedRows:previous.length,replacementRows:prices.length,before:previous,note:'Existing request snapshots and spent budget are immutable; only future quotes and separate historical supplements change.'};
}
