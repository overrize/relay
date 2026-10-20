import {createHash} from "node:crypto";
import type {AuditRow} from "./Audit.js";
import {yieldIO} from "./Storage.js";
import type {SessionJournal} from "./Journal.js";

/** Endpoint fingerprints separate a proxy's price from the official API price.
 * Only the fingerprint is persisted; credentials, query strings and paths are not. */
export function priceEndpoint(provider?:string,baseUrl?:string){
  const url=new URL(baseUrl??(provider==="anthropic"?"https://api.anthropic.com":"https://api.openai.com"));
  const identity=`${url.protocol}//${url.host}${url.pathname.replace(/\/+$/,"").replace(/\/v1$/,"")}`;
  return createHash("sha256").update(identity).digest("hex");
}
export interface PriceRetirement {id:string;at:number;action:"revoke"|"replace";reason:string;replacementDigest?:string;migration?:true}
export interface PriceRevision {target:string;targetVersions?:string[];migration?:true;action:"revoke"|"replace";reason:string;replacementDigest?:string;prices:PriceDefinition[];preview:string}
export interface PriceDefinition{
  provider:string;model:string;endpoint:string;inputRate:number;outputRate:number;
  source:string;since:number;recordedAt:number;legacy:boolean;
  retired?:PriceRetirement;replacesDigest?:string;replacesVersions?:string[];
  origin?:"official"|"contract";version?:string;previousVersion?:string;expiresAt?:number;
  sourceDocumentHash?:string;parserVersion?:string;issuer?:string;importDigest?:string;
  basis?:"upper-bound"|"catalog-estimate"|"contract-estimate";currency?:"USD"|"CNY";
  components?:Record<string,number>;
  fx?:{source:string;date:string;usdPerUnit:number;version:string};
}
export function validatePrice(value:PriceDefinition){
  if(!value.provider||!value.model||!value.endpoint||![value.inputRate,value.outputRate,value.since,value.recordedAt].every(n=>Number.isFinite(n)&&n>=0)||!value.source||value.source.length>120||!/^[-\p{L}\p{N}_.:/]+$/u.test(value.source)||typeof value.legacy!=="boolean")throw Error("Invalid price definition; provide nonnegative USD/M rates, source label and effective date");
  if(value.expiresAt!==undefined&&(!Number.isFinite(value.expiresAt)||value.expiresAt<=value.since))throw Error("Invalid price validity window");
  if(value.components&&Object.values(value.components).some(n=>!Number.isFinite(n)||n<0))throw Error("Invalid price components");
  return value;
}
export function recordPrice(journal:SessionJournal,model:{provider:string;model:string;baseUrl?:string},inputRate:number,outputRate:number,options:{source:string;since?:number;legacy?:boolean}){
  const price=validatePrice({provider:model.provider,model:model.model,endpoint:priceEndpoint(model.provider,model.baseUrl),inputRate,outputRate,source:options.source,since:options.since??0,recordedAt:Date.now(),legacy:options.legacy??false});
  journal.append("pricing.defined","pm","user",0,price,state=>{if(state.contractPrices?.some(p=>!p.retired&&p.provider===price.provider&&p.model===price.model&&p.endpoint===price.endpoint&&(p.expiresAt??Infinity)>price.since))throw Error("PRICE_IMPORT_INTERVAL_CONFLICT");});return price;
}
type PriceBucket={manual:PriceDefinition[];contract:PriceDefinition[];official:PriceDefinition[]};
const lookups=new WeakMap<PriceDefinition[],{length:number;scopes:Map<string,PriceBucket>}>();
/** Retain all versions; lifecycle metadata changes only the current price book. */
export function applyPriceRevision(prices:PriceDefinition[],data:PriceRevision,event:{id:string;ts:number}){
  const retirement:PriceRetirement={id:event.id,at:event.ts,action:data.action,reason:data.reason,...(data.replacementDigest?{replacementDigest:data.replacementDigest}:{}),...(data.migration?{migration:true as const}:{})};
  for(let i=0;i<prices.length;i++){const p=prices[i]!;if(p.origin==="contract"&&p.importDigest===data.target.split(":")[0]&&(!data.targetVersions||data.targetVersions.includes(p.version??""))&&!p.retired)prices[i]={...p,retired:retirement};}
  prices.push(...structuredClone(data.prices));lookups.delete(prices);
}
export function priceFor(row:AuditRow,prices:PriceDefinition[]){
  let lookup=lookups.get(prices);
  if(!lookup||lookup.length!==prices.length){
    const scopes=new Map<string,PriceBucket>();
    for(const p of prices)for(const endpoint of [p.endpoint,...(p.legacy?[null]:[])]){
      const key=JSON.stringify([p.provider,p.model,endpoint]),bucket=scopes.get(key)??{manual:[],contract:[],official:[]};scopes.set(key,bucket);bucket[p.origin??"manual"].push(p);
    }
    for(const bucket of scopes.values())for(const list of [bucket.manual,bucket.contract,bucket.official])list.sort((a,b)=>a.since-b.since||a.recordedAt-b.recordedAt);
    lookup={length:prices.length,scopes};lookups.set(prices,lookup);
  }
  const at=row.requestedAt??row.at,bucket=lookup.scopes.get(JSON.stringify([row.provider,row.model,row.endpoint??null]));
  if(!bucket)return;
  const choose=(list:PriceDefinition[])=>{let low=0,high=list.length;while(low<high){const middle=(low+high)>>>1;if(list[middle]!.since<=at)low=middle+1;else high=middle;}for(let i=low-1;i>=0;i--){const p=list[i]!;if(!p.retired&&(p.expiresAt===undefined||p.expiresAt>at))return p;}};
  return choose(bucket.manual)??choose(bucket.contract)??choose(bucket.official);
}
export function supplementPrice(row:AuditRow,prices:PriceDefinition[]){
  const price=priceFor(row,prices);
  if(!price)return {state:"missing-price" as const};
  const provenance={source:price.source,version:price.version,issuer:price.issuer,importDigest:price.importDigest,sourceDocumentHash:price.sourceDocumentHash,basis:price.basis,currency:price.currency,fx:price.fx,since:price.since,recordedAt:price.recordedAt,legacy:!row.endpoint};
  if(row.state!=="measured"||row.inputTokens===undefined||row.outputTokens===undefined)return {state:"unmeasured" as const,...provenance};
  return {state:"supplemented" as const,microUsd:Math.ceil(row.inputTokens*price.inputRate+row.outputTokens*price.outputRate),inputRate:price.inputRate,outputRate:price.outputRate,...provenance};
}
export const emptyPricing=()=>({resolved:0,unresolved:0,unmeasured:0,microUsd:0,byModel:[] as {provider:string;model:string;resolved:number;unresolved:number;unmeasured:number;microUsd:number}[]});
export function adjustPricing(total:ReturnType<typeof emptyPricing>,row:AuditRow,prices:PriceDefinition[],direction:1|-1){
  if(row.billing==="subscription"||row.pricingKnown)return;
  let g=total.byModel.find(g=>g.provider===(row.provider??"unknown")&&g.model===(row.model??"unknown"));
  if(!g){g={provider:row.provider??"unknown",model:row.model??"unknown",resolved:0,unresolved:0,unmeasured:0,microUsd:0};total.byModel.push(g);}
  const estimate=supplementPrice(row,prices),field=estimate.state==="missing-price"?"unresolved":estimate.state==="unmeasured"?"unmeasured":"resolved";
  total[field]+=direction;g[field]+=direction;if(estimate.state==="supplemented"){total.microUsd+=direction*estimate.microUsd;g.microUsd+=direction*estimate.microUsd;}
}
export async function supplementPrices(rows:Iterable<AuditRow>,prices:PriceDefinition[]){
  const total=emptyPricing();let count=0;
  for(const row of rows){
    adjustPricing(total,row,prices,1);
    if(++count%128===0)await yieldIO();
  }
  return total;
}
