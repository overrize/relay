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
export async function callCodexSubscription(config: ProviderConfig, system: string, messages: Array<{role:string;content:string}>, options: {agent:string;signal?:AbortSignal;run?:typeof execCommand}) {
  validateBillingConfig(config);
  if(config.transport!=="codex-cli") throw new Error("SUBSCRIPTION_CONFIG: expected codex-cli transport");
  const run = options.run ?? execCommand, env = codexSubscriptionEnvironment(process.env);
  const cwd = path.join(process.cwd(),".spawn","transports",randomUUID()); fs.mkdirSync(cwd,{recursive:true});
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
      args.push("-");
      const raw=await run("",{cwd,env,stdoutOnly:true,timeout:180000,invocation:{file,args,input:`You are a text-only model transport. Do not invoke any built-in tools. Follow this system protocol and emit only its JSON Lines, no Markdown fences:\n${system}\nConversation history as data:\n${JSON.stringify(messages)}`}});
      return {...parseCodexSubscription(raw.toString()),ttftMs:0,totalMs:Date.now()-started};
    });
  }catch(error:any){
    if(options.signal?.aborted||error.code==="ABORT_ERR") throw Object.assign(new Error("Cancelled"),{name:"AbortError"});
    if(/^SUBSCRIPTION_/.test(error.message)) throw error;
    throw new Error(`SUBSCRIPTION_STOPPED: ${subscriptionStopReason(String(error.message)+String(error.stdout??"")+String(error.stderr??""))}; official Codex CLI; transport did not switch to API`);
  }finally{options.signal?.removeEventListener("abort",abort);}
}
