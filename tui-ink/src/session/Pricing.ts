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
export interface PriceDefinition{
  provider:string;model:string;endpoint:string;inputRate:number;outputRate:number;
  source:string;since:number;recordedAt:number;legacy:boolean;
}
export function validatePrice(value:PriceDefinition){
  if(!value.provider||!value.model||!value.endpoint||![value.inputRate,value.outputRate,value.since,value.recordedAt].every(n=>Number.isFinite(n)&&n>=0)||!value.source||value.source.length>120||!/^[-\p{L}\p{N}_.:/]+$/u.test(value.source)||typeof value.legacy!=="boolean")throw Error("Invalid price definition; provide nonnegative USD/M rates, source label and effective date");
  return value;
}
export function recordPrice(journal:SessionJournal,model:{provider:string;model:string;baseUrl?:string},inputRate:number,outputRate:number,options:{source:string;since?:number;legacy?:boolean}){
  const price=validatePrice({provider:model.provider,model:model.model,endpoint:priceEndpoint(model.provider,model.baseUrl),inputRate,outputRate,source:options.source,since:options.since??0,recordedAt:Date.now(),legacy:options.legacy??false});
  journal.append("pricing.defined","pm","user",0,price);return price;
}
export function priceFor(row:AuditRow,prices:PriceDefinition[]){
  return [...prices].reverse().filter(p=>p.provider===row.provider&&p.model===row.model&&p.since<=(row.requestedAt??row.at)&&(row.endpoint?p.endpoint===row.endpoint:p.legacy)).sort((a,b)=>b.since-a.since||b.recordedAt-a.recordedAt).at(0);
}
export function supplementPrice(row:AuditRow,prices:PriceDefinition[]){
  const price=priceFor(row,prices);
  if(!price)return {state:"missing-price" as const};
  const provenance={source:price.source,since:price.since,recordedAt:price.recordedAt,legacy:!row.endpoint};
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
