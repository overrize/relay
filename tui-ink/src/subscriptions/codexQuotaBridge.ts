import { spawn } from "node:child_process";
import readline from "node:readline";

/** One read-only official app-server exchange. Executed in the supervised tree. */
export async function codexQuota() {
  const args=["app-server","--stdio","-c",'forced_login_method="chatgpt"',"-c",'model_provider="openai"'];
  for(const name of ["apps","plugins","hooks","multi_agent","shell_tool"])args.push("--disable",name);
  const child=spawn(process.env.SPAWN_CODEX_EXECUTABLE??"codex",args,{windowsHide:true,stdio:["pipe","pipe","ignore"]});
  const waiting=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();let next=0;
  child.stdin.on("error",()=>{});
  const lines=readline.createInterface({input:child.stdout});
  lines.on("line",line=>{try{const m=JSON.parse(line),w=waiting.get(m.id);if(!w)return;waiting.delete(m.id);if(m.error)w.reject(new Error("quota-rpc-failed"));else w.resolve(m.result);}catch{}});
  const fail=()=>{for(const w of waiting.values())w.reject(new Error("quota-process-failed"));waiting.clear();};child.on("error",fail);child.on("exit",fail);
  const request=(method:string,params?:unknown)=>new Promise<any>((resolve,reject)=>{const id=++next;waiting.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+"\n");});
  const timer=setTimeout(()=>{fail();child.kill();},12000);
  try{
    await request("initialize",{clientInfo:{name:"spawn-usage",version:"1"},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized"}\n');
    const account=await request("account/read",{refreshToken:false});if(account?.account?.type!=="chatgpt")throw new Error("login-required");
    return await request("account/rateLimits/read");
  }finally{clearTimeout(timer);lines.close();child.stdin.end();const close=new Promise<void>(r=>child.once("close",()=>r()));await Promise.race([close,new Promise<void>(r=>setTimeout(r,1000).unref())]);if(child.exitCode===null)child.kill();}
}
if(process.argv[1]?.replace(/\\/g,"/").endsWith("/codexQuotaBridge.js")){
  try{process.stdout.write(JSON.stringify(await codexQuota()));}catch{process.stdout.write(JSON.stringify({errorCode:"codex-quota-unavailable"}));process.exitCode=1;}
}
