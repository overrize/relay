import { CopilotClient } from "@github/copilot-sdk";
import path from "node:path";
import { createRequire } from "node:module";
import { copilotHome } from "./usage.js";

export function copilotExecutable():string {
  if(process.env.SPAWN_COPILOT_EXECUTABLE)return process.env.SPAWN_COPILOT_EXECUTABLE;
  const require=createRequire(import.meta.url), platforms=process.platform==="linux"&&require("detect-libc").isNonGlibcLinuxSync()?["linuxmusl","linux"]:[process.platform];
  for(const platform of platforms)try{return require.resolve(`@github/copilot-${platform}-${process.arch}`);}catch{}
  throw new Error("SUBSCRIPTION_CONFIG: copilot-native-runtime-missing");
}
export async function runCopilot(payload:any,suppliedClient?:CopilotClient) {
  if(!["quota","infer"].includes(payload?.operation))throw new Error("SUBSCRIPTION_STOPPED: invalid-operation");
  const client=suppliedClient??new CopilotClient({connection:{kind:"stdio",path:copilotExecutable()},mode:"empty",baseDirectory:copilotHome(),workingDirectory:process.cwd(),useLoggedInUser:true,logLevel:"none"});
  try{
    await client.start();const auth=await client.getAuthStatus();
    if(!auth.isAuthenticated||auth.authType==="api-key")throw new Error("SUBSCRIPTION_AUTH: copilot-login-required");
    if(payload.operation==="quota")return await client.rpc.account.getQuota({});
    const models=await client.listModels();if(!models.some(m=>m.id===payload.model))throw new Error("SUBSCRIPTION_STOPPED: model-not-available");
    const session=await client.createSession({model:payload.model,allowedModels:[payload.model],availableTools:[],excludedTools:["builtin:*","mcp:*"],enableConfigDiscovery:false,skipCustomInstructions:true,infiniteSessions:{enabled:false},systemMessage:{mode:"replace",content:payload.system},modelCapabilities:{limits:{max_output_tokens:payload.maxOutput}},onPermissionRequest:async()=>({kind:"denied-interactively-by-user"})});
    let input=0,output=0,calls=0,known=false,stop=false;
    session.on(event=>{
      if(event.type==="assistant.usage") {const d=event.data;calls++;if(typeof d.inputTokens==="number"&&typeof d.outputTokens==="number"){input+=d.inputTokens;output+=d.outputTokens;known=true;}if(calls>1||output>payload.maxOutput){stop=true;void session.abort();}}
      if(event.type==="tool.execution_start"){stop=true;void session.abort();}
    });
    const budgetError=()=>Object.assign(new Error("SUBSCRIPTION_BUDGET: copilot-allocation-exhausted"),{usage:known?{inputTokens:input,outputTokens:output}:undefined});
    let response;
    try{response=await session.sendAndWait({prompt:JSON.stringify(payload.messages)},60000);}catch(error){if(stop)throw budgetError();throw error;}
    if(stop||calls>1)throw budgetError();
    if(!response?.data.content)throw new Error("SUBSCRIPTION_STOPPED: empty Copilot response");
    return {text:response.data.content,promptTokens:known?input:undefined,completionTokens:known?output:undefined};
  }finally{await client.stop();}
}
if(process.argv[1]?.replace(/\\/g,"/").endsWith("/copilotBridge.js")){
  let raw="";for await(const chunk of process.stdin){raw+=chunk;if(raw.length>2000000)throw new Error("SUBSCRIPTION_BUDGET: oversized input");}
  try{process.stdout.write(JSON.stringify(await runCopilot(JSON.parse(raw))));}catch(error:any){const code=/^SUBSCRIPTION_(AUTH|BUDGET|STOPPED): [a-z-]+/.exec(error.message)?.[0]??"SUBSCRIPTION_STOPPED: copilot-runtime-failed";process.stdout.write(JSON.stringify({errorCode:code,usage:error.usage}));process.exitCode=1;}
}
