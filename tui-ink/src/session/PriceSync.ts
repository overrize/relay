import fs from "node:fs";
import path from "node:path";
import {sessionJournal} from "./Journal.js";
import {digest} from "./Storage.js";
import {priceEndpoint,priceFor,validatePrice,type PriceDefinition} from "./Pricing.js";

export interface PriceModel{provider:string;model:string;baseUrl?:string;transport?:string;billing?:{mode:string;inputUsdPerMillion?:number;outputUsdPerMillion?:number}}
export interface PriceSyncStatus{source:string;state:"fresh"|"error";checkedAt:number;retryAt:number;lastSuccess?:number;failures:number;code?:string;etag?:string;lastModified?:string;documentHash?:string;models?:string[];changes?:number}
export const priceSources={deepseek:"https://api-docs.deepseek.com/quick_start/pricing/",kimi:"https://platform.kimi.ai/docs/pricing/chat.md",kimiCN:"https://platform.kimi.com/docs/pricing/chat.md",openrouter:"https://openrouter.ai/api/v1/models",fx:"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"} as const;
type Source=Exclude<keyof typeof priceSources,"fx">;
interface ParsedPrice{model:string;currency:"USD"|"CNY";inputRate:number;outputRate:number;components:Record<string,number>}
const freshMs=6*3600000,validMs=24*3600000;
export function priceSourceFor(model:PriceModel):Source|undefined{
  if(model.billing?.mode==="subscription"||(model.transport&&model.transport!=="http"))return;
  try{const u=new URL(model.baseUrl??"https://api.openai.com");if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.port)return;
    const p=u.pathname.replace(/\/+$/,"");
    if(u.hostname==="api.deepseek.com"&&["","/v1","/anthropic","/anthropic/v1"].includes(p))return "deepseek";
    if(["","/v1"].includes(p)&&model.provider==="openai"){
      if(u.hostname==="api.moonshot.ai")return "kimi";if(u.hostname==="api.moonshot.cn")return "kimiCN";
    }
    if(u.hostname==="openrouter.ai"&&["/api","/api/v1"].includes(p)&&model.provider==="openai")return "openrouter";
  }catch{/* invalid or custom endpoint: retain manual prices */}
}
function rate(value:unknown){if(typeof value!=="number"&&!(typeof value==="string"&&/^\d+(?:\.\d+)?$/.test(value)))throw Error("invalid-price-schema");const n=Number(value);if(!Number.isFinite(n)||n<0||n>1e9)throw Error("invalid-price-schema");return n;}
function text(html:string){return html.replace(/<sup[\s\S]*?<\/sup>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/\s+/g," ").trim();}
/** A data-only table reader: never execute provider HTML/MDX/JavaScript. */
function tableGrid(html:string){
  const rows:string[][]=[];
  for(const [y,row] of [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].entries()){
    rows[y]??=[];let x=0;
    for(const cell of row[1]!.matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)){
      while(rows[y]![x]!==undefined)x++;
      const width=Number(/colspan=["']?(\d+)/i.exec(cell[1]!)?.[1]??1),height=Number(/rowspan=["']?(\d+)/i.exec(cell[1]!)?.[1]??1);
      if(width>20||height>50)throw Error("invalid-price-schema");
      for(let dy=0;dy<height;dy++){rows[y+dy]??=[];for(let dx=0;dx<width;dx++)rows[y+dy]![x+dx]=text(cell[2]!);}x+=width;
    }
  }return rows;
}
export function parsePriceSource(source:Source,body:string):ParsedPrice[]{
  const result:ParsedPrice[]=[];
  if(source==="deepseek"){
    const table=body.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];if(!table)throw Error("invalid-price-schema");
    const grid=tableGrid(table),head=grid[0];if(head?.[0]!=="MODEL"||head.length!==5)throw Error("invalid-price-schema");
    for(let column=3;column<5;column++){
      const model=head[column]!;if(!/^deepseek-[\w.-]+$/.test(model))throw Error("invalid-price-schema");
      const components:Record<string,number>={};
      for(const row of grid.filter(r=>r[0]?.startsWith("PRICING"))){
        const category=row[1]?.includes("CACHE HIT")?"cached":row[1]?.includes("CACHE MISS")?"input":row[1]?.includes("OUTPUT")?"output":undefined;
        if(!category||!row[1]?.startsWith("1M ")||!["OFF-PEAK","PEAK"].includes(row[2]??"")||!/^\$\d+(?:\.\d+)?$/.test(row[column]??""))throw Error("invalid-price-schema");
        components[category+(row[2]==="PEAK"?"Peak":"OffPeak")]=rate(row[column]!.slice(1));
      }
      if(Object.keys(components).length!==6)throw Error("invalid-price-schema");
      result.push({model,currency:"USD",inputRate:Math.max(components.inputPeak!,components.inputOffPeak!),outputRate:Math.max(components.outputPeak!,components.outputOffPeak!),components});
    }
  }else if(source==="kimi"||source==="kimiCN"){
    const currency=source==="kimi"?"USD":"CNY",symbol=currency==="USD"?"$":"¥";
    for(const block of body.matchAll(/<DocTable\b[\s\S]*?\n[ \t]*\/>/g)){
      if(!/Output Price|输出价格/.test(block[0])||!/Input Price|输入价格/.test(block[0]))throw Error("invalid-price-schema");
      const titles=[...block[0].matchAll(/title:\s*"([^"]+)"/g)].map(t=>t[1]!);
      for(const row of block[0].matchAll(/^\s*\["(kimi-[\w.-]+)",\s*"1M tokens",([^\n]+)\],?\s*$/gm)){
        const content=row[2]!.replace(/\{"\$"\}/g,"$").replace(/<[^>]*>/g,""),values=[...content.matchAll(/([$¥])\s*(\d+(?:\.\d+)?)/g)];
        if(values.some(v=>v[1]!==symbol)||![3,5].includes(values.length))throw Error("invalid-price-schema");
        const expected=values.length===5?[/^(Model|模型)$/, /^(Unit|计费单位)$/, /(?:Cache Write|缓存写入).*5min/, /(?:Cache Write|缓存写入).*1h/, /^(Cached Input Price|输入价格（缓存命中）)$/, /^(Input Price|输入价格（缓存未命中）)$/, /^(Output Price|输出价格)$/, /^(Context Window|上下文窗口)$/]:[/^(Model|模型)$/, /^(Unit|计费单位)$/, /^(Input Price \(Cache Hit\)|输入价格（缓存命中）)$/, /^(Input Price \(Cache Miss\)|输入价格（缓存未命中）)$/, /^(Output Price|输出价格)$/, /^(Context Window|上下文窗口)$/];
        if(titles.length!==expected.length||expected.some((pattern,i)=>!pattern.test(titles[i]!)))throw Error("invalid-price-schema");
        const n=values.map(v=>rate(v[2]));const components:Record<string,number>=values.length===5?{write5m:n[0]!,write1h:n[1]!,cached:n[2]!,input:n[3]!,output:n[4]!}:{cached:n[0]!,input:n[1]!,output:n[2]!};
        result.push({model:row[1]!,currency,inputRate:Math.max(components.cached,components.input+Math.max(components.write5m??0,components.write1h??0)),outputRate:components.output,components});
      }
    }
  }else{
    const value=JSON.parse(body);if(!Array.isArray(value.data)||value.data.length>5000)throw Error("invalid-price-schema");
    for(const row of value.data){
      if(typeof row.id!=="string"||row.id.length>160||!/^[-\w.:/]+$/.test(row.id)||!row.pricing)continue;
      const prices=[row.pricing,...(Array.isArray(row.pricing.overrides)?row.pricing.overrides:[])];
      if(prices.some(p=>["request","image","web_search","audio"].some(k=>p[k]!==undefined&&Number(p[k])!==0)))continue;
      try{const input=Math.max(...prices.map(p=>rate(p.prompt??row.pricing.prompt)))*1e6,output=Math.max(...prices.map(p=>rate(p.completion??row.pricing.completion)))*1e6;
        const write=Math.max(0,...prices.map(p=>rate(p.input_cache_write??0)))*1e6;
        result.push({model:row.id,currency:"USD",inputRate:input+write,outputRate:output,components:{input,output,cacheWrite:write}});
      }catch{/* Dynamic/unsupported entries must not become free models. */}
    }
  }
  if(!result.length||new Set(result.map(p=>p.model)).size!==result.length)throw Error("invalid-price-schema");return result;
}
export function parseFx(body:string,now:number){
  const date=/<Cube time=['"]([^'"]+)['"]/.exec(body)?.[1],at=Date.parse(date??"");
  const usd=Number(/currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(body)?.[1]),cny=Number(/currency=['"]CNY['"]\s+rate=['"]([\d.]+)['"]/.exec(body)?.[1]);
  if(!Number.isFinite(at)||at>now+86400000||now-at>7*86400000||!(usd>0&&cny>0))throw Error("invalid-or-stale-fx");
  return {source:priceSources.fx,date:date!,usdPerUnit:usd/cny,version:digest({date,usd,cny})};
}
async function boundedBody(response:Response){
  if(!response.body)throw Error("empty-price-response");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>2*1024*1024)throw Error("oversized-price-response");chunks.push(r.value);}return Buffer.concat(chunks).toString("utf8");}finally{await reader.cancel().catch(()=>{});}
}
function lease(root:string,source:string){
  const dir=path.join(root,".spawn","prices");fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,digest(source)+".lock");
  try{const fd=fs.openSync(file,"wx",0o600);try{fs.writeFileSync(fd,String(process.pid));}finally{fs.closeSync(fd);}return ()=>{try{fs.unlinkSync(file);}catch(e:any){if(e.code!=="ENOENT")throw e;}};}
  catch(e:any){if(e.code!=="EEXIST")throw e;const pid=Number(fs.readFileSync(file,"utf8"));if(!Number.isSafeInteger(pid)||pid<1){if(Date.now()-fs.statSync(file).mtimeMs>30000){fs.unlinkSync(file);return lease(root,source);}return;}
    try{process.kill(pid,0);}catch(error:any){if(error.code==="ESRCH"){fs.unlinkSync(file);return lease(root,source);}}return;}
}
const running=new Map<string,Promise<PriceSyncStatus[]>>();
export function syncModelPrices(models:PriceModel[],root=process.cwd(),options:{force?:boolean;fetch?:typeof fetch;now?:()=>number;signal?:AbortSignal}={}):Promise<PriceSyncStatus[]>{
  const selected=models.filter(m=>priceSourceFor(m)),key=path.resolve(root)+digest(selected.map(m=>[m.provider,m.model,m.baseUrl]));
  const existing=running.get(key);if(existing)return existing;
  const promise=performSync(selected,root,options).finally(()=>running.delete(key));running.set(key,promise);return promise;
}
export function formatPriceStatus(models:PriceModel[],root=process.cwd()){
  const j=sessionJournal(root),prices=j.prices(),statuses=j.priceStatus();
  return ["可信价格同步（手工配置优先，自动价格为文本推理估算；不含税费/工具调用/交易汇差）",...models.map(m=>{
    if(m.billing?.mode==="subscription"||(m.transport&&m.transport!=="http"))return `${m.model} · 订阅，API 单价不适用`;
    const source=priceSourceFor(m);if(!source)return `${m.model} · 未支持/代理端点，保留手工价格`;
    const status=statuses.find(s=>s.source===priceSources[source]),price=priceFor({provider:m.provider,model:m.model,endpoint:priceEndpoint(m.provider,m.baseUrl),at:Date.now()} as any,prices);
    const manual=m.billing?.inputUsdPerMillion!==undefined&&m.billing.outputUsdPerMillion!==undefined?`手工价 $${m.billing.inputUsdPerMillion}/$${m.billing.outputUsdPerMillion} 优先；官方候选：`:"";
    const state=price?`$${price.inputRate.toFixed(6)}/$${price.outputRate.toFixed(6)} 每百万输入/输出；${price.basis==="catalog-estimate"?"目录估价":"保守估算"}；到期 ${new Date(price.expiresAt!).toISOString()}`:status?.models&&!status.models.includes(m.model)?"官方目录没有可用的此精确模型单价（缺项或计费方式未支持），未猜测价格":"没有有效自动价格";
    return `${m.model} · ${manual}${state}\n来源 ${priceSources[source]}；${status?.code??status?.state??"尚未同步"}${status?`；下次允许查询 ${new Date(status.retryAt).toISOString()}`:""}${price?.version?`；版本 ${price.version}`:""}${price?.fx?`；原币 CNY，参考换算 ${price.fx.date} ${price.fx.source}`:""}`;
  }),"/prices sync 手动刷新（遵守错误退避）；/prices history 查看持久价格版本；/audit --json 查看调用时快照。"].join("\n");
}
async function performSync(models:PriceModel[],root:string,options:{force?:boolean;fetch?:typeof fetch;now?:()=>number;signal?:AbortSignal}){
  if(!models.length)return [];
  const j=sessionJournal(root),fetcher=options.fetch??fetch,now=options.now??Date.now,groups=new Map<Source,PriceModel[]>();
  for(const model of models){const source=priceSourceFor(model)!;groups.set(source,[...(groups.get(source)??[]),model]);}
  let fx:ReturnType<typeof parseFx>|undefined;
  const get=async(url:string,headers:Record<string,string>={})=>{
    const timeout=AbortSignal.timeout(10000),signal=options.signal?AbortSignal.any([timeout,options.signal]):timeout;
    return fetcher(url,{headers,signal,redirect:"error"});
  };
  for(const [id,configured] of groups){
    const source=priceSources[id],previous=j.priceStatus().find(s=>s.source===source),time=now();
    if(previous?.state==="error"&&previous.retryAt>time)continue;
    const missing=configured.some(m=>previous?.models?.includes(m.model)&&!j.prices().some(p=>p.model===m.model&&p.endpoint===priceEndpoint(m.provider,m.baseUrl)));
    if(!options.force&&!missing&&previous?.state==="fresh"&&previous.retryAt>time)continue;
    const release=lease(root,source);if(!release)continue;
    try{
      const response=await get(source,!missing&&previous?.etag?{"If-None-Match":previous.etag}:!missing&&previous?.lastModified?{"If-Modified-Since":previous.lastModified}:{});
      let parsed:ParsedPrice[]|undefined,documentHash=previous?.documentHash,etag=previous?.etag,lastModified=previous?.lastModified;
      if(response.status!==304){
        if(!response.ok)throw Error(`price-http-${response.status}`);
        const body=await boundedBody(response);parsed=parsePriceSource(id,body);documentHash=digest(body);
        etag=response.headers.get("etag")?.slice(0,256)??undefined;lastModified=response.headers.get("last-modified")?.slice(0,120)??undefined;
      }else if(!previous?.lastSuccess||missing)throw Error("price-304-without-model-snapshot");
      if(id==="kimiCN"){
        const r=await get(priceSources.fx);if(!r.ok)throw Error("fx-unavailable");fx=parseFx(await boundedBody(r),time);
      }
      let changes=0;
      for(const model of configured){
        const endpoint=priceEndpoint(model.provider,model.baseUrl),old=j.prices().find(p=>p.model===model.model&&p.provider===model.provider&&p.endpoint===endpoint),entry=parsed?.find(p=>p.model===model.model);
        if(parsed&&!entry)continue;if(!entry&&!old)continue;
        const components=entry?.components??old!.components!,currency=entry?.currency??old!.currency!,conversion=currency==="CNY"?fx:undefined;
        const inputRate=entry?entry.inputRate*(conversion?.usdPerUnit??1):currency==="CNY"?old!.inputRate/old!.fx!.usdPerUnit*conversion!.usdPerUnit:old!.inputRate;
        const outputRate=entry?entry.outputRate*(conversion?.usdPerUnit??1):currency==="CNY"?old!.outputRate/old!.fx!.usdPerUnit*conversion!.usdPerUnit:old!.outputRate;
        const version=digest({model:model.model,currency,components,fx:conversion?.version});
        const same=old?.version===version,continuous=same&&old!.expiresAt!>time;
        const price:PriceDefinition=validatePrice({provider:model.provider,model:model.model,endpoint,source,origin:"official",sourceDocumentHash:documentHash,parserVersion:"official-text-prices-v1",version,previousVersion:!same?old?.version:old?.previousVersion,since:continuous?old!.since:time,recordedAt:time,expiresAt:time+validMs,inputRate,outputRate,legacy:false,basis:id==="openrouter"?"catalog-estimate":"upper-bound",currency,components,...(conversion?{fx:conversion}:{})});
        j.append("pricing.defined","pm","price-sync",0,price);if(!same)changes++;
      }
      j.append("pricing.sync","pm","price-sync",0,{source,state:"fresh",checkedAt:time,retryAt:time+freshMs,lastSuccess:time,failures:0,etag,lastModified,documentHash,models:parsed?.map(p=>p.model)??previous!.models,changes} satisfies PriceSyncStatus);
    }catch(error){
      const raw=String(error),code=/price-http-\d{3}|invalid-price-schema|invalid-or-stale-fx|oversized-price-response|price-304-without-model-snapshot|fx-unavailable/.exec(raw)?.[0]??(options.signal?.aborted?"price-sync-cancelled":"price-network-or-timeout");
      const failures=(previous?.failures??0)+1;
      j.append("pricing.sync","pm","price-sync",0,{...previous,source,state:"error",checkedAt:time,retryAt:time+Math.min(3600000,60000*2**Math.min(failures-1,6)),failures,code} satisfies PriceSyncStatus);
    }finally{release();}
  }
  return j.priceStatus();
}
