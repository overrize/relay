import { subscriptionStopReason } from "../adapters/subscriptionErrors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelRoute, routeCanFallback } from "../models/routing.js";
import { loadConfig, resolveModelConfigInput } from "../config.js";
import { codexSubscriptionEnvironment, parseCodexSubscription, callCodexSubscription } from "../adapters/codexSubscription.js";
import type { execCommand } from "../tools/command.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cfg = () => ({ ...loadConfig(), models: {
  claude: resolveModelConfigInput("claude-subscription","sonnet")!,
  codex: resolveModelConfigInput("codex-subscription","test-model")!,
  api: {provider:"openai" as const,model:"test-api",apiKey:"fixture-key"},
  absent: {provider:"openai" as const,model:"test-empty",apiKey:""},
}, routing: { profiles: { implement:["claude","codex","api"], research:["api"] }, allowApiFallback:false } });
test("ranked profiles prefer configured subscription channels and block implicit paid fallback",()=>{
  const route=resolveModelRoute(cfg(),"worker","implement"); assert.deepEqual(route.candidates.map(c=>c.name),["claude","codex"]);
  assert.deepEqual(route.skipped,[{name:"api",reason:"api-fallback-disabled"}]);
  assert.equal(resolveModelRoute(cfg(),"worker","research").candidates[0]!.name,"api");
});
test("operator opt-in allows API fallback without changing subscription identity or credentials",()=>{
  const c=cfg();c.routing.allowApiFallback=true;const r=resolveModelRoute(c,"worker","implement");assert.deepEqual(r.candidates.map(c=>c.name),["claude","codex","api"]);
  assert.equal(r.candidates[0]!.config.apiKey,"");assert.equal(r.candidates[2]!.config.apiKey,"fixture-key");
});
test("dispatch model overrides cannot bypass profile chain or subscription billing policy",()=>{
  assert.throws(()=>resolveModelRoute(cfg(),"worker","implement","api"),/API fallback/);
  assert.throws(()=>resolveModelRoute(cfg(),"worker","implement","unregistered-model"),/not in/);
  assert.equal(resolveModelRoute(cfg(),"worker","implement","codex").candidates[0]!.config.transport,"codex-cli");
});
test("empty credentials are skipped and legacy role configuration remains available without routing",()=>{
  const c=cfg(); c.routing.profiles.research=["absent","api"]; const r=resolveModelRoute(c,"worker","research");assert.equal(r.skipped[0]!.reason,"missing-api-credential");assert.equal(r.candidates[0]!.name,"api");
  const legacy=loadConfig();delete legacy.routing;assert.equal(resolveModelRoute(legacy,"leader","pm").candidates[0]!.name,legacy.agents.leader.model);
});
test("routing only advances on availability failures, never budget fences or cancellation",()=>{
  for(const s of ["HTTP 429","HTTP 503","SUBSCRIPTION_AUTH: expired","SUBSCRIPTION_STOPPED: quota"])assert.equal(routeCanFallback(new Error(s)),true);
  for(const s of ["SESSION_BUDGET_EXHAUSTED","AbortError","invalid billing config","SUBSCRIPTION_PROTOCOL: bad response"])assert.equal(routeCanFallback(new Error(s)),false);
});
test("Codex text transport validates one completed turn and refuses nested tool receipts",()=>{
  const events=[{type:"item.completed",item:{type:"agent_message",text:"OK"}},{type:"turn.completed",usage:{input_tokens:20,output_tokens:5,cached_input_tokens:10}}];
  assert.deepEqual(parseCodexSubscription(events.map(e=>JSON.stringify(e)).join("\n")),{text:"OK",promptTokens:20,completionTokens:5});
  assert.throws(()=>parseCodexSubscription([...events,{type:"item.completed",item:{type:"command_execution"}}].map(e=>JSON.stringify(e)).join("\n")),/nested/);
  assert.throws(()=>parseCodexSubscription(JSON.stringify({type:"turn.failed"})),/SUBSCRIPTION_STOPPED/);
});
test("Codex subscription environment removes API/proxy overrides and keeps official login home",()=>{
  const env=codexSubscriptionEnvironment({OPENAI_API_KEY:"secret",OPENAI_BASE_URL:"https://elsewhere",CODEX_API_KEY:"secret",CODEX_HOME:"E:/login",PATH:"path"});
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.OPENAI_BASE_URL,undefined);assert.equal(env.CODEX_API_KEY,undefined);assert.equal(env.CODEX_HOME,"E:/login");
});
test("Codex API-key login never proceeds to a model invocation",async()=>{
  const original=process.cwd();process.chdir(fs.mkdtempSync(path.join(os.tmpdir(),"spawn-codex-auth-")));let calls=0;
  try{await assert.rejects(callCodexSubscription(resolveModelConfigInput("codex-subscription","test-model")!,"",[],{agent:"pm",run:(async()=>{calls++;return Buffer.from("Logged in using an API key");}) as typeof execCommand}),/SUBSCRIPTION_AUTH/);assert.equal(calls,1);}finally{process.chdir(original);}
});

test("subscription diagnostics retain actionable categories without leaking CLI account text",()=>{
  assert.equal(subscriptionStopReason("account private@example.invalid hit your limit"),"quota-or-rate-limit");
  assert.equal(subscriptionStopReason("The model is not supported with this account"),"model-not-available");
  assert.equal(subscriptionStopReason("OAuth token expired for account private@example.invalid"),"login-required");
});
