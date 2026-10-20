import { fileURLToPath } from "node:url";
import { execCommand, withToolCancellation, cancelAgentTools } from "../tools/command.js";
import { validateBillingConfig, type ProviderConfig } from "../config.js";
import { copilotEnvironment } from "../subscriptions/usageProviders.js";

export function parseCopilotResult(raw:string) {
  let result:any;try{result=JSON.parse(raw);}catch{throw new Error("SUBSCRIPTION_PROTOCOL: invalid Copilot JSON");}
  if(result.errorCode)throw Object.assign(new Error(/^SUBSCRIPTION_(AUTH|STOPPED|BUDGET): [a-z-]+/.exec(String(result.errorCode))?.[0]??"SUBSCRIPTION_STOPPED: copilot-runtime-failed"),{usage:result.usage});
  if(typeof result.text!=="string"||!result.text)throw new Error("SUBSCRIPTION_PROTOCOL: empty Copilot response");
  const valid=[result.promptTokens,result.completionTokens].every(n=>Number.isSafeInteger(n)&&n>=0);
  return {text:result.text,promptTokens:valid?result.promptTokens:undefined,completionTokens:valid?result.completionTokens:undefined};
}
export async function callCopilotSubscription(config:ProviderConfig,system:string,messages:Array<{role:string;content:string}>,options:{agent:string;maxOutput:number;signal?:AbortSignal;run?:typeof execCommand}) {
  validateBillingConfig(config);if(config.transport!=="copilot-sdk")throw new Error("SUBSCRIPTION_CONFIG: expected copilot-sdk");
  const started=Date.now(),abort=()=>cancelAgentTools(options.agent),run=options.run??execCommand;
  options.signal?.addEventListener("abort",abort,{once:true});
  try{return await withToolCancellation(options.agent,async()=>{
    if(options.signal?.aborted)throw Object.assign(new Error("Cancelled"),{name:"AbortError"});
    const invocation={file:process.execPath,args:[fileURLToPath(new URL("../subscriptions/copilotBridge.js",import.meta.url))],input:JSON.stringify({operation:"infer",model:config.model,system,messages,maxOutput:options.maxOutput})};
    let bytes:Buffer;
    try{bytes=await run("",{env:copilotEnvironment(process.env),stdoutOnly:true,timeout:75000,invocation});}
    catch(error:any){if(error.stdout){parseCopilotResult(error.stdout.toString());}throw error;}
    return {...parseCopilotResult(bytes.toString()),ttftMs:0,totalMs:Date.now()-started};
  });}catch(error:any){
    if(options.signal?.aborted||error.code==="ABORT_ERR")throw Object.assign(new Error("Cancelled"),{name:"AbortError"});
    if(/^SUBSCRIPTION_/.test(error.message))throw error;
    throw new Error("SUBSCRIPTION_STOPPED: copilot-runtime-failed");
  }finally{options.signal?.removeEventListener("abort",abort);}
}
