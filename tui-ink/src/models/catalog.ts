import {fileURLToPath} from "node:url";
import {catalogSnapshot} from "./catalogSnapshot.js";
import {execCommand,withToolCancellation,cancelAgentTools} from "../tools/command.js";
import {codexSubscriptionEnvironment} from "../adapters/codexSubscription.js";
import {copilotEnvironment} from "../subscriptions/usageProviders.js";
export interface ModelChoice {id:string;label:string}
export interface ModelCatalog {models:ModelChoice[];source:"account"|"prepared";reason?:string}
function choices(rows:any[]):ModelChoice[]{const seen=new Set<string>();return rows.slice(0,1000).flatMap(row=>{const id=typeof row==="string"?row:row?.id;if(typeof id!=="string"||!id.trim()||id.length>160||/[\x00-\x1f\x7f]/.test(id)||seen.has(id))return [];seen.add(id);return [{id,label:typeof row.name==="string"?row.name.replace(/[\x00-\x1f\x7f]/g,"").slice(0,120):id}];});}
export function preparedCatalog(provider:string,mode:string):ModelCatalog {
  const p=catalogSnapshot.providers,key=provider==="codex"?"openai":provider==="claude"?(mode==="subscription"?"anthropic-subscription":"anthropic"):provider==="copilot"?"github-copilot":provider==="kimi"?"moonshotai-cn":provider;
  const models=key in p?p[key as keyof typeof p]:Object.values(p).flat();return {models:choices([...models]),source:"prepared"};
}
async function jsonBounded(response:Response){
  if(!response.body)throw new Error("invalid-model-response");const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>2*1024*1024)throw new Error("oversized-model-response");chunks.push(item.value);}return JSON.parse(Buffer.concat(chunks).toString());}finally{await reader.cancel().catch(()=>{});}
}
export async function discoverModels(provider:string,mode:string,endpoint:string,key:string,signal:AbortSignal,fetcher=fetch,run=execCommand):Promise<ModelCatalog>{
  const fallback=preparedCatalog(provider,mode);
  if(provider==="claude"&&mode==="subscription")return {...fallback,reason:"claude-catalog-not-probed"};
  try{
    let models:ModelChoice[];
    if(mode==="subscription"){
      const owner="human-model-catalog",abort=()=>cancelAgentTools(owner);signal.addEventListener("abort",abort,{once:true});
      try{models=await withToolCancellation(owner,async()=>{if(signal.aborted)throw new Error("cancelled");const helper=fileURLToPath(new URL(provider==="codex"?"../subscriptions/codexQuotaBridge.js":"../subscriptions/copilotBridge.js",import.meta.url));const bytes=await run("",{env:provider==="codex"?codexSubscriptionEnvironment(process.env):copilotEnvironment(process.env),stdoutOnly:true,timeout:20000,invocation:{file:process.execPath,args:[helper],input:JSON.stringify({operation:"models"})}});return choices(JSON.parse(bytes.toString()).models??[]);});}finally{signal.removeEventListener("abort",abort);}
    }else{
      const url=new URL(endpoint.replace(/\/$/,"")+(/\/v1$/.test(endpoint.replace(/\/$/,""))?"/models":"/v1/models"));
      if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new Error("invalid-model-endpoint");
      const rows:any[]=[];let complete=false;
      for(let page=0;page<10;page++){
        const response=await fetcher(url,{headers:provider==="claude"?{"x-api-key":key,"anthropic-version":"2023-06-01"}:{Authorization:`Bearer ${key}`},redirect:"error",signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
        if(!response.ok)throw new Error(`models-http-${response.status}`);
        const data=await jsonBounded(response);if(!Array.isArray(data.data))throw new Error("invalid-model-response");rows.push(...data.data);
        if(!data.has_more){complete=true;break;}const cursor=data.last_id??data.data.at(-1)?.id;if(typeof cursor!=="string"||!cursor||rows.length>=1000)throw new Error("model-pagination-incomplete");url.searchParams.set(provider==="claude"?"after_id":"after",cursor);
      }
      if(!complete)throw new Error("model-pagination-incomplete");models=choices(rows);
    }
    if(!models.length)throw new Error("empty-model-catalog");return {models,source:"account"};
  }catch(error){const message=error instanceof Error?error.message:"";return {...fallback,reason:/^(?:models-http-\d{3}|invalid-model-response|empty-model-catalog|model-pagination-incomplete|oversized-model-response)$/.test(message)?message:signal.aborted?"catalog-cancelled":"catalog-unavailable"};}
}
