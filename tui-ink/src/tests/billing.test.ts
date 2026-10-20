import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelConfigInput, validateBillingConfig } from "../config.js";
import { callClaudeSubscription, parseSubscriptionResult, subscriptionEnvironment } from "../adapters/claudeSubscription.js";
import { sessionJournal, SessionJournal } from "../session/Journal.js";
import { reserveSessionRequest, settleSessionRequest, budgetReport } from "../session/Budget.js";
import { execCommand } from "../tools/command.js";
import { restoreBackup } from "../session/Backup.js";
import { waitForIndexing } from "../session/SearchIndex.js";
import http from "node:http";
import { HttpConvAgent } from "../adapters/httpAgent.js";
import { resolveModelRoute } from "../models/routing.js";
import { loadConfig } from "../config.js";

const original = process.cwd(), savedEnv = { ...process.env };
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-billing-"));
const config = { provider: "anthropic" as const, model: "sonnet", apiKey: "", transport: "claude-cli" as const, billing: { mode: "subscription" as const } };
const success = { type: "result", subtype: "success", result: "OK", num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 }, total_cost_usd: 100 };
beforeEach(() => {
  process.chdir(fs.mkdtempSync(path.join(fixture, "case-")));
  for (const k of Object.keys(process.env)) if (k.startsWith("SPAWN_SESSION_") || k.startsWith("SPAWN_COMMUNICATION_") || k.startsWith("SPAWN_INPUT_") || k.startsWith("SPAWN_OUTPUT_")) delete process.env[k];
  process.env.SPAWN_SESSION_MAX_REQUESTS = "10"; process.env.SPAWN_COMMUNICATION_REQUESTS = "1";
});
afterEach(async () => { await waitForIndexing(); process.chdir(original); process.env = { ...savedEnv }; });

test("subscription registration needs no API key; legacy API registration still works", () => {
  assert.deepEqual(resolveModelConfigInput("claude-subscription", "sonnet"), config);
  assert.equal(resolveModelConfigInput("openai", "example-model", "test-key")!.apiKey, "test-key");
});
test("billing configuration rejects invalid prices and API credentials on subscription CLI", () => {
  validateBillingConfig(config);
  assert.throws(() => validateBillingConfig({ ...config, apiKey: "must-not-be-used" }), /without API key/);
  assert.throws(() => validateBillingConfig({ ...config, billing: { mode: "api" } }), /subscription/);
  assert.throws(() => validateBillingConfig({ ...config, billing: { mode: "subscription", inputUsdPerMillion: Infinity } }), /Prices/);
});
test("subscription subprocess cannot inherit API endpoints, credentials, or cloud switches", () => {
  const source = { ANTHROPIC_API_KEY: "secret", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "https://elsewhere", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "E:/login", PATH: "path" };
  const env = subscriptionEnvironment(source, 512);
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined); assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR); assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "512"); assert.equal(source.ANTHROPIC_API_KEY, "secret");
});
test("CLI usage includes cached input; CLI dollar estimate is not subscription billing", () => {
  const r = parseSubscriptionResult(JSON.stringify(success)); assert.equal(r.promptTokens, 33); assert.equal(r.completionTokens, 5);
  assert.equal(parseSubscriptionResult(JSON.stringify({ ...success, usage: undefined })).promptTokens, undefined);
  assert.throws(() => parseSubscriptionResult(JSON.stringify({ ...success, num_turns: 2 })), /one bounded/);
  assert.throws(() => parseSubscriptionResult(JSON.stringify({ ...success, is_error: true })), /SUBSCRIPTION_STOPPED/);
});
test("subscription checks official login, sends history over stdin, and disables nested tools", async () => {
  const calls: any[] = [];
  const run = (async (_command: string, options: any) => { calls.push(options); return Buffer.from(JSON.stringify(calls.length === 1 ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" } : success)); }) as typeof execCommand;
  const r = await callClaudeSubscription(config, "system", [{ role: "user", content: "literal $() and `text`" }], { agent: "pm", maxOutput: 512, run });
  assert.equal(r.text, "OK"); assert.equal(calls.length, 2);
  const args = calls[1].invocation.args; assert.equal(args[args.indexOf("--tools") + 1], ""); assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  assert.ok(args.includes("--strict-mcp-config")); assert.ok(args.includes("--no-session-persistence")); assert.match(calls[1].invocation.input, /literal \$\(\)/);
});
test("API login is refused before any subscription model invocation", async () => {
  let calls = 0; const run = (async () => { calls++; return Buffer.from(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })); }) as typeof execCommand;
  await assert.rejects(callClaudeSubscription(config, "", [], { agent: "pm", maxOutput: 512, run }), /SUBSCRIPTION_AUTH/); assert.equal(calls, 1);
});
test("pre-cancelled subscription does not launch a process", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(callClaudeSubscription(config, "", [], { agent: "pm", maxOutput: 512, signal: abort.signal, run: (async () => { calls++; return Buffer.from(""); }) as typeof execCommand }), { name: "AbortError" }); assert.equal(calls, 0);
});
test("structured supervised process preserves stdin and literal argv without shell expansion", async () => {
  const input = "literal $(not-a-command) `test` & data";
  const result = await execCommand("", { stdoutOnly: true, invocation: { file: process.execPath, args: ["-e", "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(JSON.stringify({s,arg:process.argv[1]})))", input], input } });
  assert.deepEqual(JSON.parse(result.toString()), { s: input, arg: input });
});
test("API and subscription share request/token pool but only API adds per-model estimated USD", () => {
  const j = sessionJournal(); j.bind("pm", "Leader");
  const api = reserveSessionRequest("pm", 100, 50, false, { provider: "openai", model: "priced", billing: { mode: "api", inputUsdPerMillion: 2, outputUsdPerMillion: 4 } })!;
  settleSessionRequest("pm", api.id, 20, 10);
  const sub = reserveSessionRequest("pm", 100, 50, false, config)!; settleSessionRequest("pm", sub.id, 30, 10);
  assert.equal(j.budget()!.used.requests, 2); assert.equal(j.budget()!.used.tokens, 70); assert.equal(j.budget()!.used.microUsd, 80);
  assert.deepEqual(j.budget()!.byBilling, { api: { requests: 1, tokens: 30, microUsd: 80 }, subscription: { requests: 1, tokens: 40, microUsd: 0 } });
  assert.equal(new SessionJournal(process.cwd()).budget()!.used.requests, 2); assert.match(JSON.stringify(budgetReport()), /external and unknown/);
});
test("subscription still works after API money cap, but cannot bypass shared request cap", () => {
  process.env.SPAWN_SESSION_MAX_USD = "0.0001"; process.env.SPAWN_INPUT_USD_PER_MILLION = "1"; process.env.SPAWN_OUTPUT_USD_PER_MILLION = "1";
  const j = sessionJournal(); j.bind("pm", "Leader");
  assert.throws(() => reserveSessionRequest("pm", 500, 500), /SESSION_BUDGET/);
  for (let i = 0; i < 9; i++) { const p = reserveSessionRequest("pm", 10, 10, false, config)!; settleSessionRequest("pm", p.id, 5, 5); }
  assert.throws(() => reserveSessionRequest("pm", 10, 10, false, config), /SESSION_BUDGET/);
});
test("subscription unknown usage and old backup restore preserve billed-mode counters", async () => {
  const root = process.cwd(), j = sessionJournal(); j.bind("pm", "Leader"); const p = reserveSessionRequest("pm", 100, 50, false, config)!; settleSessionRequest("pm", p.id);
  await j.backup(); reserveSessionRequest("pm", 100, 50, false, config); await restoreBackup(root, root, { replace: true }); budgetReport();
  assert.equal(sessionJournal().budget()!.byBilling!.subscription.requests, 2); assert.ok(sessionJournal().budget()!.used.tokens >= 300);
});

for (const allow of [false,true]) test(`runtime ranked fallback obeys API opt-in=${allow} and charges each attempted channel`, async () => {
  const calls:string[]=[];
  const server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);
    calls.push(req.url!);
    if(req.url!.includes("unavailable")){res.writeHead(401);res.end("unavailable");return;}
    const event=JSON.stringify({v:1,type:"message",agent:"pm",to:"user",text:"FALLBACK_OK"});
    res.writeHead(200,{"Content-Type":"text/event-stream"});res.end(`data: ${JSON.stringify({choices:[{delta:{content:event}}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const c=loadConfig();c.models={sub:{provider:"openai",model:"plan",apiKey:"fixture",baseUrl:base+"/unavailable",billing:{mode:"subscription"}},api:{provider:"openai",model:"api",apiKey:"fixture",baseUrl:base+"/available",billing:{mode:"api",inputUsdPerMillion:1,outputUsdPerMillion:1}}};c.routing={profiles:{pm:["sub","api"]},allowApiFallback:allow};
  const route=resolveModelRoute(c,"leader","pm"),j=sessionJournal();j.bind("pm","Leader");
  const agent=new HttpConvAgent({id:"pm",role:"Leader",sessionManaged:true,systemPrompt:"Emit JSON message",providerCfg:route.candidates[0]!.config,modelCandidates:route.candidates,routingProfile:"pm"});
  const events:any[]=[];agent.on("event",e=>events.push(e));
  try {
    await agent.send("progress?");
    assert.equal(calls.length,allow?2:1);assert.equal(j.budget()!.byBilling!.subscription.requests,1);assert.equal(j.budget()!.byBilling!.api.requests,allow?1:0);
    assert.equal(events.some(e=>e.type==="message"&&e.text==="FALLBACK_OK"),allow);
    if(allow){assert.equal(j.budget()!.byBilling!.api.microUsd,30);assert.ok((await j.search("pm","model.fallback")).length);}
  }finally{agent.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test("unpriced API calls are explicitly marked instead of being represented as a free invoice",()=>{
  const j=sessionJournal();j.bind("pm","Leader");reserveSessionRequest("pm",100,50);assert.equal(j.budget()!.unpricedApiRequests,1);
  reserveSessionRequest("pm",100,50,false,config);assert.equal(j.budget()!.unpricedApiRequests,1);
});
