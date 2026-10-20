import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execCommand } from "../tools/command.js";
import { codexSubscriptionEnvironment } from "../adapters/codexSubscription.js";
import { UsageError, parseUsage, type UsageProvider } from "./usage.js";

export async function fetchUsage(provider:UsageProvider) {
  if(provider==="claude") {
    let token:string;
    try{token=JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR??path.join(os.homedir(),".claude"),".credentials.json"),"utf8")).claudeAiOauth.accessToken;}catch{throw new UsageError("login-required",300000);}
    if(!token)throw new UsageError("login-required",300000);
    const response=await fetch("https://api.anthropic.com/api/oauth/usage",{headers:{Authorization:`Bearer ${token}`,"anthropic-beta":"oauth-2025-04-20"},signal:AbortSignal.timeout(8000),redirect:"error"});
    if(!response.ok){const retry=response.headers.get("retry-after"),seconds=retry?Number(retry):NaN;throw new UsageError(response.status===429?"rate-limited":response.status===403?"usage-forbidden":response.status===401?"login-required":"usage-http-error",Number.isFinite(seconds)?seconds*1000:response.status===429?120000:300000,response.status);}
    const bytes=await response.arrayBuffer();if(bytes.byteLength>262144)throw new UsageError("invalid-usage-response");
    try{return parseUsage(provider,JSON.parse(Buffer.from(bytes).toString()));}catch{throw new UsageError("invalid-usage-response");}
  }
  const helper=fileURLToPath(new URL(provider==="codex"?"./codexQuotaBridge.js":"./copilotBridge.js",import.meta.url));
  let bytes:Buffer;
  try{bytes=await execCommand("",{env:provider==="codex"?codexSubscriptionEnvironment(process.env):copilotEnvironment(process.env),stdoutOnly:true,timeout:20000,invocation:{file:process.execPath,args:[helper],input:JSON.stringify({operation:"quota"})}});}catch(error:any){let code="";try{code=JSON.parse(error.stdout?.toString()??"{}").errorCode??"";}catch{}throw new UsageError(code.startsWith("SUBSCRIPTION_AUTH")||code==="codex-login-required"?`${provider}-login-required`:/^codex-(?:quota-rpc-failed|quota-process-failed|quota-timeout)$/.test(code)?code:`${provider}-quota-unavailable`,120000);}
  try{const data=JSON.parse(bytes.toString());if(data.errorCode)throw new UsageError("login-or-quota-unavailable",120000);return parseUsage(provider,data);}catch(error){if(error instanceof UsageError)throw error;throw new UsageError("invalid-usage-response");}
}
export function copilotEnvironment(source:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const env={...source};for(const key of Object.keys(env))if(/^(?:GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_TOKEN|COPILOT_(?:API_|BASE_URL|PROVIDER|MODEL)|OPENAI_|ANTHROPIC_|NODE_TEST_CONTEXT$)/i.test(key))delete env[key];return env;
}
