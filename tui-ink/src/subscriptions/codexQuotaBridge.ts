import { spawn } from "node:child_process";
import readline from "node:readline";

/** One read-only official app-server exchange. Executed in the supervised tree. */
export async function codexQuota(operation:"quota"|"models"="quota") {
  const args=["app-server","--stdio","-c",'forced_login_method="chatgpt"',"-c",'model_provider="openai"'];
  for(const name of ["apps","plugins","hooks","multi_agent","shell_tool"])args.push("--disable",name);
  const child=spawn(process.env.SPAWN_CODEX_EXECUTABLE??"codex",args,{windowsHide:true,stdio:["pipe","pipe","ignore"]});
  const waiting=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let next=0;
  child.stdin.on("error",()=>{});
  const lines=readline.createInterface({input:child.stdout});
  lines.on("line",line=>{try{const m=JSON.parse(line),w=waiting.get(m.id);if(!w)return;waiting.delete(m.id);if(m.error)w.reject(new Error("quota-rpc-failed"));else w.resolve(m.result);}catch{}});
  const fail=()=>{for(const w of waiting.values())w.reject(new Error("quota-process-failed"));waiting.clear();};child.on("error",fail);child.on("exit",fail);
  const request=(method:string,params?:unknown)=>new Promise<any>((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+"\n");});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;fail();child.kill();},12000);
  try{
    await request("initialize",{clientInfo:{name:"spawn-usage",version:"1"},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
    const account=await request("account/read",{refreshToken:false});if(account?.account?.type!=="chatgpt")throw new Error("login-required");
    if(operation==="models"){
      const models:any[]=[];let cursor:string|undefined;
      for(let page=0;page<10;page++){const result=await request("model/list",{limit:100,includeHidden:false,...(cursor?{cursor}:{})});models.push(...(result?.data??[]).map((m:any)=>({id:m.model,name:m.displayName})));cursor=result?.nextCursor;if(!cursor)return {models};}
      throw new Error("quota-rpc-failed");
    }
    return await request("account/rateLimits/read");
  }catch(error){if(timedOut)throw new Error("quota-timeout");throw error;}
  finally{clearTimeout(timer);lines.close();child.stdin.end();const close=new Promise<void>(r=>child.once("close",()=>r()));await Promise.race([close,new Promise<void>(r=>setTimeout(r,1000).unref())]);if(child.exitCode===null)child.kill();}
}
if(process.argv[1]?.replace(/\\/g,"/").endsWith("/codexQuotaBridge.js")){
  try{let input="";for await(const chunk of process.stdin){input+=chunk;if(input.length>1024)throw new Error("invalid-operation");}const operation=JSON.parse(input||"{}").operation??"quota";if(!["models","quota"].includes(operation))throw new Error("invalid-operation");process.stdout.write(JSON.stringify(await codexQuota(operation)));}catch(error){const reason=error instanceof Error?error.message:"";process.stdout.write(JSON.stringify({errorCode:["login-required","quota-rpc-failed","quota-process-failed","quota-timeout"].includes(reason)?`codex-${reason}`:"codex-quota-unavailable"}));process.exitCode=1;}
}
