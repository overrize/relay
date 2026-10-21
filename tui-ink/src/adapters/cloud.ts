import {BedrockRuntimeClient,ConverseCommand} from '@aws-sdk/client-bedrock-runtime';
import {fromNodeProviderChain} from '@aws-sdk/credential-providers';
import {jsonBounded} from '../models/catalog.js';
import {GoogleAuth} from 'google-auth-library';
import {validateBillingConfig,type ProviderConfig} from '../config.js';

export function awsCredentials(profile?:string){return fromNodeProviderChain(profile?{profile}:{});}
const google=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
export async function cancellable<T>(task:Promise<T>,signal?:AbortSignal,timeout=30000):Promise<T>{
 const bounded=AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(timeout)]);
 let abort:()=>void=()=>{};try{return await Promise.race([task,new Promise<never>((_,reject)=>{abort=()=>reject(new DOMException("Authentication cancelled or timed out","AbortError"));bounded.addEventListener("abort",abort,{once:true});if(bounded.aborted)abort();})]);}finally{bounded.removeEventListener("abort",abort);}
}
export async function checkCloud(cfg:ProviderConfig,signal?:AbortSignal){
 validateBillingConfig(cfg);
 try{if(cfg.transport==='bedrock')await cancellable(awsCredentials(cfg.cloud?.profile)(),signal);else if(cfg.transport==='vertex')await cancellable(google.getAccessToken(),signal);else throw new Error();}
 catch{throw new Error(cfg.transport==='bedrock'?'AWS 凭据不可用：检查 profile、SSO 登录或工作负载身份':'GCP ADC 不可用：运行 gcloud auth application-default login，或配置工作负载身份');}
}
export function vertexEndpoint(cfg:ProviderConfig){
 validateBillingConfig(cfg);const {project,region}=cfg.cloud!;
 return `https://${region==='global'?'':region+'-'}aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/openapi/chat/completions`;
}
export async function callCloud(cfg:ProviderConfig,system:string,messages:{role:string;content:string}[],maxOutput:number,signal?:AbortSignal,deps?:{bedrock?:()=>BedrockRuntimeClient;token?:()=>Promise<string|null>;fetcher?:typeof fetch}){
 validateBillingConfig(cfg);signal?.throwIfAborted();const t=Date.now();
 let text:string,promptTokens:number|undefined,completionTokens:number|undefined;
 try{
 if(cfg.transport==='bedrock'){
  const client=deps?.bedrock?.()??new BedrockRuntimeClient({region:cfg.cloud!.region,credentials:awsCredentials(cfg.cloud!.profile),maxAttempts:1,requestHandler:{connectionTimeout:10000,requestTimeout:120000}});
  try{const r=await cancellable(client.send(new ConverseCommand({modelId:cfg.model,system:system?[{text:system}]:undefined,messages:messages.map(m=>({role:m.role==='assistant'?'assistant':'user',content:[{text:m.content}]})),inferenceConfig:{maxTokens:maxOutput}}),{abortSignal:signal}),signal,120000);
   text=r.output?.message?.content?.map(c=>c.text??'').join('')??'';promptTokens=r.usage?.inputTokens;completionTokens=r.usage?.outputTokens;
  }finally{client.destroy();}
 }else{
  // The library refreshes ADC; tokens never enter the model registry or event journal.
  const token=await cancellable(deps?.token?.()??google.getAccessToken(),signal);signal?.throwIfAborted();if(!token)throw new Error('ADC');
  const r=await (deps?.fetcher??fetch)(vertexEndpoint(cfg),{method:'POST',redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(120000)]),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({model:cfg.model.startsWith("google/")?cfg.model:"google/"+cfg.model,max_tokens:maxOutput,messages:[...(system?[{role:'system',content:system}]:[]),...messages],stream:false})});
  if(!r.ok)throw new Error(`Vertex HTTP ${r.status}`);
  const body=await jsonBounded(r);text=body.choices?.[0]?.message?.content??'';promptTokens=body.usage?.prompt_tokens;completionTokens=body.usage?.completion_tokens;
 }
 }catch(e){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');const name=(e as {name?:string}).name??'',code=/^(AccessDeniedException|UnrecognizedClientException|ExpiredTokenException|CredentialsProviderError|ValidationException|ResourceNotFoundException|ThrottlingException|ServiceUnavailableException|AbortError)$/.test(name)?name:'CloudError';throw new Error(cfg.transport==='bedrock'?`Bedrock request failed (${code}); check credentials, region, IAM and model access`:`Vertex request failed; check ADC, project, region, IAM and model access${e instanceof Error&&/^Vertex HTTP \d+$/.test(e.message)?': '+e.message:''}`);}
 if(typeof text!=='string'||!text)throw new Error('Cloud returned no text');
 return {text,promptTokens,completionTokens,ttftMs:Date.now()-t,totalMs:Date.now()-t};
}
