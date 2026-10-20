import { fileURLToPath } from "node:url";
import {execCommand,withToolCancellation,cancelAgentTools} from "../tools/command.js";
import {codexSubscriptionEnvironment} from "../adapters/codexSubscription.js";
import {subscriptionEnvironment} from "../adapters/claudeSubscription.js";
import {copilotExecutable} from "./copilotBridge.js";
import {copilotHome} from "./usage.js";
import {copilotEnvironment} from "./usageProviders.js";

/** Human-only authentication. No quota queries or inference, no API-key fallback. */
export async function officialSubscriptionLogin(provider:string,login:boolean,onOutput:(text:string)=>void,signal:AbortSignal,run=execCommand){
  const owner="human-subscription-login",abort=()=>cancelAgentTools(owner);signal.addEventListener("abort",abort,{once:true});
  const env=provider==="codex"?codexSubscriptionEnvironment(process.env):provider==="claude"?subscriptionEnvironment(process.env,1024):{...copilotEnvironment(process.env),COPILOT_HOME:copilotHome()};
  const file=provider==="codex"?(process.env.SPAWN_CODEX_EXECUTABLE??"codex"):provider==="claude"?(process.env.SPAWN_CLAUDE_EXECUTABLE??"claude"):provider==="copilot"?copilotExecutable():undefined;
  if(!file)throw new Error("Unsupported subscription provider");
  try{return await withToolCancellation(owner,async()=>{
    if(signal.aborted)throw new Error("Login cancelled");
    if(login){const args=provider==="codex"?["login","--device-auth"]:provider==="claude"?["auth","login","--claudeai"]:["login","--device-code"];
      // Instructions stay in this transient widget, never journal/transcript.
      let buffer="";const display=(chunk:Buffer)=>{buffer=(buffer+chunk.toString()).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/[\x00-\x08\x0b-\x1f\x7f]/g,"").slice(-4096);onOutput(buffer);};
      await run("",{env,timeout:300000,inspectStdout:display,inspectStderr:display,invocation:{file,args}});
    }
    if(signal.aborted)throw new Error("Login cancelled");
    if(provider==="copilot"){
      const result=await run("",{env,timeout:20000,stdoutOnly:true,invocation:{file:process.execPath,args:[fileURLToPath(new URL("./copilotBridge.js",import.meta.url))],input:JSON.stringify({operation:"auth"})}});
      if(!JSON.parse(result.toString()).authenticated)throw new Error("Subscription login required");
    }else{
      const result=await run("",{env,timeout:15000,stdoutOnly:true,invocation:{file,args:provider==="codex"?["login","status"]:["auth","status"]}});
      if(provider==="codex"){if(!/^Logged in using ChatGPT\s*$/m.test(result.toString()))throw new Error("ChatGPT subscription login required");}
      else{const auth=JSON.parse(result.toString());if(!auth.loggedIn||auth.authMethod!=="claude.ai"||auth.apiProvider!=="firstParty")throw new Error("Claude subscription login required");}
    }
  });}finally{signal.removeEventListener("abort",abort);}
}
