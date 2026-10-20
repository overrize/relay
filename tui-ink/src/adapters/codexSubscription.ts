import { validateCodexHostProtocol, assertCodexBudgetCapability, codexPrompt, codexAllocation, codexOutputGuard, codexOutputSchema, measuredCodexBudgetError } from "./codexBudget.js";
import { subscriptionStopReason } from "./subscriptionErrors.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execCommand, withToolCancellation, cancelAgentTools } from "../tools/command.js";
import { validateBillingConfig, type ProviderConfig } from "../config.js";

export function codexSubscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_|NODE_TEST_CONTEXT$)/i.test(key)) delete env[key];
  if (source.CODEX_HOME) env.CODEX_HOME = source.CODEX_HOME; // Official CLI retains ownership of login.
  return env;
}
export function parseCodexSubscription(raw: string) {
  const events = raw.trim().split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch { throw new Error("SUBSCRIPTION_PROTOCOL: invalid Codex JSONL"); } });
  if (events.some((e) => e.type === "turn.failed" || e.type === "error")) throw new Error(`SUBSCRIPTION_STOPPED: ${subscriptionStopReason(raw)}; inspect the official Codex CLI`);
  // No nested execution may be treated as one managed text-only completion.
  const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
  if (items.some((i) => !["agent_message","reasoning"].includes(i?.type))) throw new Error("SUBSCRIPTION_PROTOCOL: nested Codex tool execution is not permitted");
  const turns = events.filter((e) => e.type === "turn.completed");
  if (turns.length !== 1) throw new Error("SUBSCRIPTION_PROTOCOL: expected one completed Codex turn");
  const text = items.filter((i) => i.type === "agent_message").map((i) => i.text).join("\n");
  if (!text) throw new Error("SUBSCRIPTION_PROTOCOL: no final Codex response");
  const usage = turns[0].usage, valid = [usage?.input_tokens,usage?.output_tokens].every((n) => Number.isSafeInteger(n) && n >= 0);
  return { text, promptTokens: valid ? usage.input_tokens : undefined, completionTokens: valid ? usage.output_tokens : undefined };
}
export async function callCodexSubscription(config: ProviderConfig, system: string, messages: Array<{role:string;content:string}>, options: {agent:string;signal?:AbortSignal;run?:typeof execCommand;maxOutput?:number;maxInput?:number;hostProtocol?:boolean}) {
  validateBillingConfig(config);
  assertCodexBudgetCapability();
  if(config.transport!=="codex-cli") throw new Error("SUBSCRIPTION_CONFIG: expected codex-cli transport");
  const allocation=codexAllocation(options.maxOutput??config.maxTokens??2048,options.maxInput??65536);
  const run = options.run ?? execCommand, env = codexSubscriptionEnvironment(process.env);
  const cwd = path.join(process.cwd(),".spawn","transports",randomUUID()); fs.mkdirSync(cwd,{recursive:true});
  const schema=path.join(cwd,"output-schema.json");fs.writeFileSync(schema,JSON.stringify(codexOutputSchema(allocation)),{mode:0o600});
  const file = process.env.SPAWN_CODEX_EXECUTABLE || "codex", started = Date.now(), abort = () => cancelAgentTools(options.agent);
  options.signal?.addEventListener("abort",abort,{once:true});
  try {
    return await withToolCancellation(options.agent,async()=>{
      if(options.signal?.aborted) throw Object.assign(new Error("Cancelled"),{name:"AbortError"});
      const login = await run("",{cwd,env,timeout:15000,invocation:{file,args:["login","status"]}});
      if(!/^Logged in using ChatGPT\s*$/m.test(login.toString())) throw new Error("SUBSCRIPTION_AUTH: ChatGPT login required; API-key login is refused");
      const args = ["exec","--json","--ephemeral","--ignore-user-config","--ignore-rules","--skip-git-repo-check","--sandbox","read-only","--model",config.model,
        "-c",'forced_login_method="chatgpt"',"-c",'model_provider="openai"',"-c",'approval_policy="never"',"-c",'web_search="disabled"',"-c","project_doc_max_bytes=0"];
      for(const feature of ["shell_tool","unified_exec","multi_agent","apps","plugins","hooks","computer_use","browser_use","image_generation","view_image"]) args.push("--disable",feature);
      if(config.reasoningEffort) args.push("-c",`model_reasoning_effort=${JSON.stringify(config.reasoningEffort)}`);
      args.push("--output-schema",schema,"-");
      const input=codexPrompt(system,messages);
      if(Buffer.byteLength(input,"utf8")+16384>allocation.maxInput)throw new Error("SUBSCRIPTION_BUDGET: Codex input exceeds allocated context");
      const raw=await run("",{cwd,env,stdoutOnly:true,timeout:allocation.timeoutMs,inspectStdout:codexOutputGuard(allocation),invocation:{file,args,input}});
      const result=parseCodexSubscription(raw.toString());
      if(result.promptTokens!==undefined&&result.completionTokens!==undefined&&(result.promptTokens>allocation.maxInput||result.completionTokens>allocation.maxOutput))throw measuredCodexBudgetError(result.promptTokens,result.completionTokens,"Codex token use exceeded allocation");
      let wrapped:any;try{wrapped=JSON.parse(result.text);}catch{throw new Error("SUBSCRIPTION_PROTOCOL: Codex did not honor output schema");}
      if(typeof wrapped.output!=="string"||[...wrapped.output].length>allocation.maxOutput)throw new Error("SUBSCRIPTION_BUDGET: Codex response exceeded output schema");
      let output=wrapped.output;
      if(options.hostProtocol)try{output=validateCodexHostProtocol(output,options.agent);}catch(error){throw Object.assign(error as Error,{usage:{inputTokens:result.promptTokens,outputTokens:result.completionTokens}});}
      return {...result,text:output,ttftMs:0,totalMs:Date.now()-started};
    });
  }catch(error:any){
    if(options.signal?.aborted||error.code==="ABORT_ERR") throw Object.assign(new Error("Cancelled"),{name:"AbortError"});
    if(/^SUBSCRIPTION_/.test(error.message)) throw error;
    throw new Error(`SUBSCRIPTION_STOPPED: ${subscriptionStopReason(String(error.message)+String(error.stdout??"")+String(error.stderr??""))}; official Codex CLI; transport did not switch to API`);
  }finally{options.signal?.removeEventListener("abort",abort);}
}
