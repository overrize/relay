import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const original = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round7-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
const { SessionJournal, sessionJournal } = await import("../session/Journal.js");
const { reserveSessionRequest, settleSessionRequest, consumeSessionTool, addSessionBudget } = await import("../session/Budget.js");
const { admitWorker, taskFor, workItems, fileHash, taskState } = await import("../session/Tasks.js");
const { prepareWorkspace, workspacePath, publishWorkspace, resolveWorkspace, workspaceChanges, recoverWorkspacePublishes } = await import("../session/Workspaces.js");
const { applyEvent, ensureAgent, _resetForTest } = await import("../store.js");
const { executeTool } = await import("../tools/registry.js");
const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
const { stopTaskRecovery, waitTaskResolution, queueTaskResolution } = await import("../runtime/TaskRecovery.js");
const { releaseRuntimeOwners } = await import("../session/RuntimeOwner.js");
const { cancelAllAgentTools } = await import("../tools/command.js");
const { restoreBackup } = await import("../session/Backup.js");
const { waitForIndexing } = await import("../session/SearchIndex.js");
let root: string;
const envKeys = ["SPAWN_SESSION_MAX_REQUESTS", "SPAWN_SESSION_MAX_TOKENS", "SPAWN_SESSION_MAX_TOOLS", "SPAWN_COMMUNICATION_REQUESTS", "SPAWN_COMMUNICATION_TOKENS", "SPAWN_SESSION_MAX_USD", "SPAWN_INPUT_USD_PER_MILLION", "SPAWN_OUTPUT_USD_PER_MILLION", "SPAWN_WORKSPACE_MAX_BYTES"];
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); _resetForTest(); process.env.SPAWN_WORKSPACE_ISOLATION = "snapshot"; for (const k of envKeys) delete process.env[k]; });
afterEach(async () => { stopTaskRecovery(); await waitTaskResolution(); stopTaskRecovery(); await waitForIndexing(); releaseRuntimeOwners(); await cancelAllAgentTools(); process.chdir(original); });
const dispatch = { background: "round seven", constraints: [], acceptance_criteria: ["artifact verified"], stop_conditions: ["agent.done"] };
function rootPM() { const j = sessionJournal(); j.bind("pm", "Leader"); return j; }
function worker(id: string, goal = id, extra: Record<string, unknown> = {}) { rootPM(); const e = { v: 1 as const, type: "spawn" as const, parent: "pm", child: id, role: "Worker" as const, goal, dispatch: { ...dispatch, ...extra } }; admitWorker(e); applyEvent(e); return taskFor(id)!; }
function done(id: string) { applyEvent({ v: 1, type: "agent.done", agent: id, success: true, reason: "stopped for verification" }); }
async function until(check: () => boolean, ms = 8000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("round7 timeout"); await new Promise((r) => setTimeout(r, 10)); } }

test("PM, Leader, Worker and forks share one pool; revision and restart do not reset it", () => {
  process.env.SPAWN_SESSION_MAX_REQUESTS = "5"; process.env.SPAWN_COMMUNICATION_REQUESTS = "1";
  const j = rootPM(); j.bind("tl", "Leader", "pm"); j.bind("w", "Worker", "tl"); j.bind("fork", "Leader");
  for (const id of ["pm", "tl", "w", "fork"]) { const p = reserveSessionRequest(id, 100, 50)!; settleSessionRequest(id, p.id, 20, 10); }
  assert.equal(j.budget()!.used.requests, 4); assert.equal(j.budget()!.used.tokens, 120);
  assert.throws(() => reserveSessionRequest("w", 100, 50), /SESSION_BUDGET/);
  j.append("requirement.changed", "pm", "pm", 1, { text: "new goal" });
  const talk = reserveSessionRequest("pm", 100, 50, true)!; assert.equal(talk.communicationOnly, true); assert.equal(new SessionJournal(root).budget()!.used.requests, 5);
  assert.throws(() => reserveSessionRequest("fork", 100, 50, true), /SESSION_BUDGET/);
});

test("unknown usage and interrupted requests keep reservations; explicit additions never erase spending", () => {
  const j = rootPM(), p = reserveSessionRequest("pm", 100, 400)!;
  settleSessionRequest("pm", p.id); settleSessionRequest("pm", p.id, 1, 1);
  assert.equal(j.budget()!.used.tokens, 500); assert.equal(j.budget()!.reservations[p.id]!.uncertain, true);
  const before = j.budget()!.used; addSessionBudget("pm", { requests: 3, tokens: 1000, tools: 2 }); assert.deepEqual(j.budget()!.used, before);
  assert.equal(j.budget()!.limits.requests, 203);
});

test("configured prices reserve cost and guard malformed/missing usage", () => {
  process.env.SPAWN_SESSION_MAX_USD = "0.001"; process.env.SPAWN_INPUT_USD_PER_MILLION = "1"; process.env.SPAWN_OUTPUT_USD_PER_MILLION = "1";
  const j = rootPM(); const p = reserveSessionRequest("pm", 100, 500)!; assert.ok(j.budget()!.used.microUsd > 0);
  settleSessionRequest("pm", p.id, Infinity, 0); assert.equal(j.budget()!.used.microUsd, 600);
  assert.throws(() => reserveSessionRequest("pm", 1000, 500), /SESSION_BUDGET/);
});

test("tool quota includes PM and Worker but leaves free budget/status inspection", async () => {
  process.env.SPAWN_SESSION_MAX_TOOLS = "1"; rootPM();
  const r = await executeTool("Write", { path: "pm.txt", content: "one" }, { agentId: "pm" }); assert.equal(r.ok, true);
  const blocked = await executeTool("Write", { path: "second.txt", content: "two" }, { agentId: "pm" }); assert.equal(blocked.code, "session_budget_exhausted"); assert.equal(fs.existsSync("second.txt"), false);
  assert.equal((await executeTool("BudgetStatus", {}, { agentId: "pm" })).ok, true);
});

test("restoring an older local event backup cannot refund known spending", async () => {
  const j = rootPM(); reserveSessionRequest("pm", 100, 50); await j.backup(); reserveSessionRequest("pm", 100, 50); consumeSessionTool("pm", "Read");
  const before = j.budget()!.used;
  await restoreBackup(root, root, { replace: true });
  reserveSessionRequest("pm", 100, 50);
  const after = sessionJournal().budget()!.used; assert.equal(after.requests, before.requests + 1); assert.equal(after.tools, before.tools); assert.ok(after.tokens >= before.tokens);
});

test("concurrent Workers edit isolated copies; conflict never overwrites another result", async () => {
  fs.writeFileSync("shared.txt", "BASE"); const a = worker("a"), b = worker("b"); await Promise.all([prepareWorkspace("a"), prepareWorkspace("b")]);
  await Promise.all([executeTool("Write", { path: "shared.txt", content: "A" }, { agentId: "a", callId: "a-write" }), executeTool("Write", { path: "shared.txt", content: "B" }, { agentId: "b", callId: "b-write" })]);
  assert.equal(fs.readFileSync("shared.txt", "utf8"), "BASE"); assert.match((await executeTool("Read", { path: "shared.txt" }, { agentId: "a" })).output, /A/); assert.match((await executeTool("Read", { path: "shared.txt" }, { agentId: "b" })).output, /B/);
  done("a"); done("b"); await publishWorkspace(taskFor("a")!);
  await assert.rejects(publishWorkspace(taskFor("b")!), /Workspace conflict/);
  assert.equal(fs.readFileSync("shared.txt", "utf8"), "A"); assert.equal(fs.readFileSync(path.join(workspacePath(taskFor("b")!), "shared.txt"), "utf8"), "B");
  await assert.rejects(resolveWorkspace("pm", b.id, "shared.txt", fileHash("BASE"), "ours"), /changed again/);
  await resolveWorkspace("pm", b.id, "shared.txt", fileHash("A"), "ours"); await publishWorkspace(taskFor("b")!);
  assert.equal(fs.readFileSync("shared.txt", "utf8"), "B"); assert.equal(workItems()[0]!.id, a.id);
});

test("non-overlapping files merge independently and keep unrelated PM changes", async () => {
  fs.writeFileSync("a.txt", "old-a"); fs.writeFileSync("b.txt", "old-b"); worker("a"); worker("b"); await Promise.all([prepareWorkspace("a"), prepareWorkspace("b")]);
  await executeTool("Write", { path: "a.txt", content: "new-a" }, { agentId: "a" }); await executeTool("Write", { path: "b.txt", content: "new-b" }, { agentId: "b" }); fs.writeFileSync("unrelated.txt", "PM"); done("a"); done("b");
  await Promise.all([publishWorkspace(taskFor("a")!), publishWorkspace(taskFor("b")!)]);
  assert.equal(fs.readFileSync("a.txt", "utf8"), "new-a"); assert.equal(fs.readFileSync("b.txt", "utf8"), "new-b"); assert.equal(fs.readFileSync("unrelated.txt", "utf8"), "PM");
});

test("shell cwd and tests use the task copy; managed paths and escapes are refused", async () => {
  worker("w"); const r = await executeTool("Bash", { command: `"${process.execPath}" -e "require('fs').writeFileSync('shell.txt','isolated')"` }, { agentId: "w", callId: "shell" }); assert.equal(r.ok, true);
  assert.equal(fs.existsSync("shell.txt"), false); assert.equal(fs.readFileSync(path.join(workspacePath(taskFor("w")!), "shell.txt"), "utf8"), "isolated");
  assert.equal((await executeTool("Write", { path: "../escape.txt", content: "bad" }, { agentId: "w", callId: "escape" })).ok, false);
  assert.equal((await executeTool("Write", { path: ".spawn/budget-floor.json", content: "bad" }, { agentId: "w", callId: "managed" })).ok, false);
});

test("read-only review can inspect the staged version explicitly; oversized snapshots fail without touching originals", async () => {
  fs.writeFileSync("result.txt", "BASE"); const t = worker("w"); await executeTool("Write", { path: "result.txt", content: "STAGED" }, { agentId: "w" });
  assert.match((await executeTool("Read", { path: "result.txt", task: t.id }, { agentId: "pm", callId: "inspect" })).output, /STAGED/);
  assert.equal(fs.readFileSync("result.txt", "utf8"), "BASE"); process.env.SPAWN_WORKSPACE_MAX_BYTES = "1";
  worker("large"); await assert.rejects(prepareWorkspace("large"), /quota exceeded/); assert.equal(fs.readFileSync("result.txt", "utf8"), "BASE");
});

test("stale revisions cannot publish staged edits", async () => {
  fs.writeFileSync("shared.txt", "BASE"); worker("w"); await executeTool("Write", { path: "shared.txt", content: "OLD" }, { agentId: "w" }); done("w");
  sessionJournal().append("requirement.changed", "pm", "pm", 1, { text: "new requirement" });
  await assert.rejects(publishWorkspace(taskFor("w")!), /obsolete/); assert.equal(fs.readFileSync("shared.txt", "utf8"), "BASE");
});

test("manual review must inspect the staged workspace before accepting and publishing", async () => {
  fs.writeFileSync("result.txt", "BASE"); const t = worker("w"); await executeTool("Write", { path: "result.txt", content: "REVIEWED" }, { agentId: "w", callId: "write" }); done("w"); queueTaskResolution("w"); await waitTaskResolution();
  applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "wrong-root", name: "Read", args: { path: "result.txt" } }); await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "wrong-root" });
  assert.equal((await executeTool("TaskReview", { task: t.id, verdict: "accept", evidence: "wrong-root", rationale: "wrong version" }, { agentId: "pm" })).ok, false);
  applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "staged", name: "Read", args: { path: "result.txt", task: t.id } }); await executeTool("Read", { path: "result.txt", task: t.id }, { agentId: "pm", callId: "staged" });
  assert.equal((await executeTool("TaskReview", { task: t.id, verdict: "accept", evidence: "staged", rationale: "checked staged result" }, { agentId: "pm" })).ok, true);
  assert.equal(fs.readFileSync("result.txt", "utf8"), "REVIEWED");
});

test("hard exit during publish recovers idempotently without losing either staged file", async () => {
  fs.writeFileSync("a.txt", "old"); fs.writeFileSync("b.txt", "old"); worker("w");
  await executeTool("Write", { path: "a.txt", content: "A" }, { agentId: "w", callId: "a" }); await executeTool("Write", { path: "b.txt", content: "B" }, { agentId: "w", callId: "b" }); done("w");
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href, workUrl = new URL("../session/Workspaces.ts", import.meta.url).href, taskUrl = new URL("../session/Tasks.ts", import.meta.url).href;
  const script = `import fs from 'node:fs';import {publishWorkspace} from ${JSON.stringify(workUrl)};import {taskFor} from ${JSON.stringify(taskUrl)};const rename=fs.promises.rename;fs.promises.rename=async(a,b)=>{await rename(a,b);if(String(b)===${JSON.stringify(path.join(root, "a.txt"))})process.exit(23)};await publishWorkspace(taskFor('w'));`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { cwd: root }), (e: any) => e.code === 23);
  assert.ok(new SessionJournal(root).current("pm")!.work![taskFor("w")!.id]!.workspace!.pending);
  await recoverWorkspacePublishes(); assert.equal(fs.readFileSync("a.txt", "utf8"), "A"); assert.equal(fs.readFileSync("b.txt", "utf8"), "B"); assert.equal(taskFor("w")!.workspace!.pending, null);
});

test("budget exhaustion leaves a bounded PM communication lane and blocks its write/spawn requests", async () => {
  process.env.SPAWN_SESSION_MAX_REQUESTS = "2"; process.env.SPAWN_COMMUNICATION_REQUESTS = "1";
  const requests: any[] = [], r = createRuntimeContext(), replies: string[] = [];
  const server = http.createServer(async (req, res) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body); const events = requests.length === 1 ? [{ type: "message", to: "user", text: "STARTED" }] : [{ type: "tool.call", id: "forbidden", name: "Write", args: { path: "should-not-exist.txt", content: "bad" } }, { type: "message", to: "user", text: "PM_STILL_HERE" }]; res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: events.map((e) => JSON.stringify(e)).join("\n") } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true }); fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local-only", baseUrl: `http://127.0.0.1:${(server.address() as any).port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  configureAgentHandlers({ ...r, MODEL: "mock", DEMO: false, buildSystemPrompt: () => "You are PM; emit JSON events", killAgent: (id) => { r.killedAgents.add(id); r.agents.get(id)?.kill(); } });
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" }); startLeaderAgent({ id: "pm", firstMessage: "start", conversationMode: true, replyHook: (s) => replies.push(s) }); await until(() => replies.includes("STARTED"));
    r.agents.get("pm")!.receiveUserInput("progress?"); await until(() => replies.includes("PM_STILL_HERE")); assert.equal(fs.existsSync("should-not-exist.txt"), false); assert.equal(requests.length, 2);
    r.agents.get("pm")!.receiveUserInput("progress again?"); await until(() => replies.some((s) => s.includes("预算已阻止"))); assert.equal(requests.length, 2);
  } finally { stopTaskRecovery(); for (const [id, a] of r.agents) { r.killedAgents.add(id); a.kill(); } for (const s of r.secretaries.values()) s.destroy(); r.pm.destroy(); await waitTaskResolution(); stopTaskRecovery(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});


test("recovery conflict blocks only its task; explicit resolution can finish the pending publish", async () => {
  fs.writeFileSync("a.txt", "BASE"); worker("w"); await executeTool("Write", {path:"a.txt",content:"STAGED"}, {agentId:"w"}); done("w");
  const t=taskFor("w")!, changes=await workspaceChanges(t);
  taskState(t,{status:"evaluating",workspace:{...t.workspace!,pending:changes.map(({path,before,after})=>({path,before,after}))}});
  fs.writeFileSync("a.txt","EXTERNAL"); await recoverWorkspacePublishes();
  assert.equal(taskFor("w")!.status,"blocked"); assert.equal(fs.readFileSync("a.txt","utf8"),"EXTERNAL");
  assert.equal((await executeTool("BudgetStatus",{}, {agentId:"pm"})).ok,true);
  await resolveWorkspace("pm",t.id,"a.txt",fileHash("EXTERNAL"),"theirs"); await publishWorkspace(taskFor("w")!);
  assert.equal(fs.readFileSync("a.txt","utf8"),"EXTERNAL");assert.equal(taskFor("w")!.workspace!.pending,null);
});

test("obsolete interrupted publication is abandoned durably without replaying old goals", async () => {
  fs.writeFileSync("a.txt","BASE");worker("w");await executeTool("Write",{path:"a.txt",content:"OLD"},{agentId:"w"});done("w");
  const t=taskFor("w")!,changes=await workspaceChanges(t);taskState(t,{workspace:{...t.workspace!,pending:changes.map(({path,before,after})=>({path,before,after}))}});
  sessionJournal().append("requirement.changed","pm","pm",1,{text:"new goal"});await recoverWorkspacePublishes();
  assert.equal(taskFor("w")!.workspace!.pending,null);assert.equal(new SessionJournal(root).current("pm")!.work![t.id]!.workspace!.pending,null);assert.equal(fs.readFileSync("a.txt","utf8"),"BASE");
});


test("offline budget command is unique and explicitly increases the persistent pool", async () => {
  const {buildCommands}=await import("../tui/commands.js"); const commands=buildCommands({emitCommandMessage:()=>{}} as any); rootPM();reserveSessionRequest("pm",100,50);
  const budget=commands.filter(c=>c.name==="budget"); assert.equal(budget.length,1); const before=sessionJournal().budget()!;
  budget[0]!.handler(["add","requests=2","tools=3"]);const after=sessionJournal().budget()!;
  assert.equal(after.limits.requests,before.limits.requests+2);assert.deepEqual(after.used,before.used);
  commands.find(c=>c.name==="contextbudget")!.handler(["100k"]);assert.equal((await import("../store.js")).getState().tokenBudget,100000);
});
