// Historical shared-workspace regression contract; round7 tests exercise the new default snapshot mode.
process.env.SPAWN_WORKSPACE_ISOLATION = "shared";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";

const original = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round2-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
const { SessionJournal, sessionJournal } = await import("../session/Journal.js");
const { acceptSessionInput, inputKind } = await import("../session/Control.js");
const { compileSessionContext } = await import("../session/Context.js");
const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
const { ensureAgent, getState, applyEvent, _resetForTest } = await import("../store.js");
const { loadMemory, appendMessage, loadMessages } = await import("../memory/MemoryStore.js");
const { executeTool } = await import("../tools/registry.js");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); _resetForTest(); });
afterEach(() => process.chdir(original));
after(async () => { await (await import("../session/SearchIndex.js")).waitForIndexing(); fs.rmSync(scratch, { recursive: true, force: true }); });
const dispatch = { background: "test", constraints: [], acceptance_criteria: ["evidence"], stop_conditions: ["agent.done"] };
async function until(check: () => boolean, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("runtime wait timed out"); await new Promise((r) => setTimeout(r, 10)); }
}

test("durable replay rebuilds goal, decisions, todos and pending operations without any snapshots", async () => {
  const j = sessionJournal(); j.bind("pm", "Leader");
  acceptSessionInput("pm", "实现 OLD_GOAL 邮箱登录", "one");
  j.append("runtime.event", "pm", "pm", 1, { type: "spawn", parent: "pm", child: "old-worker", role: "Worker", goal: "OLD_GOAL", dispatch });
  acceptSessionInput("pm", "/revise 实现 NEW_GOAL 企业 SSO", "two");
  j.append("runtime.event", "pm", "pm", 2, { type: "decision.record", decision: "保留个人邮箱入口" });
  j.append("runtime.event", "pm", "pm", 2, { type: "todo.set", items: [{ id: "sso", text: "实现 SSO", state: "todo" }] });
  j.append("runtime.event", "pm", "pm", 2, { type: "tool.call", id: "uncertain", name: "Write", args: { path: "maybe-written.txt", content: "check before retry" } });
  const rebuilt = new SessionJournal(root);
  assert.equal(rebuilt.current("pm")!.revision, 2);
  assert.match(rebuilt.current("pm")!.goal, /NEW_GOAL/);
  assert.equal(rebuilt.binding("old-worker")!.status, "superseded");
  assert.equal(rebuilt.current("pm")!.tools["pm:uncertain"]!.status, "pending");
  assert.equal(loadMemory("pm")!.dispatch.background, rebuilt.current("pm")!.goal);
  assert.equal(loadMemory("pm")!.working_set.decisions[0]!.text, "保留个人邮箱入口");
  assert.ok(loadMemory("pm")!.tombstone.pending_tool_calls?.[0]?.args);
  assert.equal(fs.existsSync(path.join(root, ".spawn/memory/pm.json")), false);
});

test("torn final append is preserved and repaired; corrupt committed records fail closed", () => {
  let j = sessionJournal(); j.bind("pm", "Leader");
  acceptSessionInput("pm", "当前目标", "goal");
  fs.appendFileSync(j.file, '{"unfinished":');
  j = new SessionJournal(root);
  assert.equal(j.current("pm")!.revision, 1);
  j.append("checkpoint", "pm", "pm", 1, {});
  assert.ok(fs.readdirSync(path.dirname(j.file)).some((name) => name.includes(".torn-")));
  const lines = fs.readFileSync(j.file, "utf8").trimEnd().split("\n");
  const first = JSON.parse(lines[0]!); first.data.role = "tampered"; lines[0] = JSON.stringify(first);
  fs.writeFileSync(j.file, lines.join("\n") + "\n");
  assert.throws(() => new SessionJournal(root), /integrity/);
});

test("long history compiles the latest goal and retained constraints; old details remain searchable", async () => {
  const j = sessionJournal(); j.bind("pm", "Leader");
  acceptSessionInput("pm", "OLD_GOAL", "initial");
  j.append("message.recorded", "pm", "pm", 1, { role: "user", content: "EARLY_FACT 项目最初在 E 盘" });
  for (let i = 0; i < 180; i++) j.append("message.recorded", "pm", "pm", 1, { role: i % 2 ? "assistant" : "user", content: "无关历史".repeat(100) });
  acceptSessionInput("pm", "/constraint 数据只能写到 E 盘", "constraint");
  acceptSessionInput("pm", "/revise NEW_GOAL", "new");
  const context = compileSessionContext("pm", "tool policy", [], 4000);
  assert.ok(context.tokens <= 4000);
  assert.match(context.system, /NEW_GOAL/); assert.match(context.system, /E 盘/);
  assert.doesNotMatch(JSON.stringify(context.messages), /OLD_GOAL/);
  const recalled = await j.search("pm", "EARLY_FACT");
  assert.equal(recalled.length, 1); assert.equal(recalled[0]!.revision, 1);
  const tool = await executeTool("SessionRecall", { query: "EARLY_FACT" }, { agentId: "pm" });
  assert.equal(tool.ok, true); assert.match(tool.output, /EARLY_FACT/);
  for (let i = 0; i < 80; i++) appendMessage("pm", { role: "user", content: `snapshot ${i}`, ts: Date.now() });
  assert.equal(loadMessages("pm").length, 50);
  assert.match((await j.search("pm", "EARLY_FACT"))[0]!.excerpt, /EARLY_FACT/);
});

test("queries preserve the target; explicit changes invalidate stale tools and duplicate inputs are idempotent", async () => {
  const j = sessionJournal(); j.bind("pm", "Leader");
  const one = acceptSessionInput("pm", "创建 A", "id1");
  assert.equal(acceptSessionInput("pm", "创建 A", "id1").id, one.id);
  acceptSessionInput("pm", "现在进度怎么样？", "q"); assert.equal(j.current("pm")!.revision, 1);
  j.bind("worker", "Worker", "pm", "A");
  acceptSessionInput("pm", "/revise 创建 B", "id2");
  const result = await executeTool("Write", { path: "obsolete.txt", content: "should not write" }, { agentId: "worker", revision: 1 });
  assert.equal(result.code, "superseded_revision"); assert.equal(fs.existsSync("obsolete.txt"), false);
  applyEvent({ v: 1, type: "decision.record", agent: "pm", decision: "OBSOLETE_DECISION", session_revision: 1 });
  assert.equal(j.current("pm")!.decisions.length, 0);
  assert.equal(inputKind("有没有必要基于 OMO？"), "query");
});

async function modelServer(reply: (body: any, index: number) => { events: any[]; delay?: number }) {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const scripted = reply(body, requests.length);
    if (scripted.delay) await new Promise((r) => setTimeout(r, scripted.delay));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: scripted.events.map((e) => JSON.stringify(e)).join("\n") } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local-only", baseUrl: `http://127.0.0.1:${port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  return { requests, stop: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
function handlers() {
  const runtime = createRuntimeContext();
  configureAgentHandlers({ ...runtime, MODEL: "mock", DEMO: false, buildSystemPrompt: (_role, id) => `**agent_id**: \`${id}\``, killAgent: (id) => { runtime.killedAgents.add(id); runtime.agents.get(id)?.kill(); runtime.pm.cancelForeground(id); } });
  return { runtime, stop: () => { for (const agent of runtime.agents.values()) agent.kill(); for (const sec of runtime.secretaries.values()) sec.destroy(); runtime.pm.destroy(); } };
}

test("delayed old model output cannot write or report success after a user revision", async () => {
  const server = await modelServer((_body, n) => n === 1 ? {
    delay: 500, events: [{ type: "tool.call", id: "old-write", name: "Write", args: { path: "old-goal.txt", content: "OLD_GOAL" } }, { type: "message", to: "user", text: "OLD_SUCCESS" }],
  } : { events: [{ type: "message", to: "user", text: "NEW_TARGET_ACK" }] });
  const h = handlers(), replies: string[] = [];
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "OLD_GOAL", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => server.requests.length === 1);
    h.runtime.agents.get("pm")!.receiveUserInput("/revise NEW_GOAL");
    await until(() => replies.includes("NEW_TARGET_ACK"));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(fs.existsSync("old-goal.txt"), false); assert.equal(replies.includes("OLD_SUCCESS"), false);
    assert.match(server.requests[1].messages[0].content, /NEW_GOAL/);
    assert.doesNotMatch(JSON.stringify(server.requests[1].messages), /OLD_GOAL/);
    assert.equal(sessionJournal().current("pm")!.revision, 2);
  } finally { h.stop(); await server.stop(); }
});

test("a fresh Node process replays pending latest input after an abrupt exit", async () => {
  const journalUrl = pathToFileURL(fileURLToPath(new URL("../session/Journal.ts", import.meta.url))).href;
  const controlUrl = pathToFileURL(fileURLToPath(new URL("../session/Control.ts", import.meta.url))).href;
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href;
  const seed = `import {sessionJournal} from ${JSON.stringify(journalUrl)}; import {acceptSessionInput} from ${JSON.stringify(controlUrl)}; const j=sessionJournal(); j.bind('pm','Leader'); acceptSessionInput('pm','OLD_GOAL','one'); acceptSessionInput('pm','/revise RESTART_NEW_GOAL','two'); j.append('runtime.event','pm','pm',2,{type:'tool.call',id:'unknown-effect',name:'Write',args:{path:'inspect-before-retry.txt',content:'do-not-replay-blindly'}}); process.exit(23);`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", seed], { cwd: root }), (e: any) => e.code === 23);
  const server = await modelServer((body) => {
    assert.match(body.messages[0].content, /RESTART_NEW_GOAL/);
    assert.match(body.messages[0].content, /inspect-before-retry/);
    return { events: [{ type: "message", to: "user", text: "RESTART_RECOVERED" }] };
  });
  const h = handlers(), replies: string[] = [];
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", resumedMemoryId: "pm", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => replies.includes("RESTART_RECOVERED"));
    assert.equal(sessionJournal().pending("pm").length, 0);
    assert.equal(sessionJournal().current("pm")!.tools["pm:unknown-effect"]!.status, "uncertain");
    assert.equal(fs.existsSync("inspect-before-retry.txt"), false);
    assert.doesNotMatch(JSON.stringify(server.requests[0].messages), /OLD_GOAL/);
  } finally { h.stop(); await server.stop(); }
});

test("PM stays responsive during a Worker command; revision cancels the old process before new writes", async () => {
  const script = path.join(root, "old-work.cjs"), started = path.join(root, "started"), obsolete = path.join(root, "obsolete-side-effect");
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(obsolete)},'obsolete'),3000)`);
  const server = await modelServer((body) => {
    const system = body.messages[0].content as string;
    const last = body.messages.at(-1).content as string;
    if (system.includes("`worker-slow`")) return { events: [{ type: "tool.call", id: "slow", name: "Bash", args: { command: `"${process.execPath}" "${script}"` } }] };
    if (last.includes("progress?")) return { events: [{ type: "message", to: "user", text: "STILL_RESPONSIVE" }] };
    if (system.includes("NEW_GOAL") && !last.includes("tool_result")) return { events: [{ type: "tool.call", id: "new-write", name: "Write", args: { path: "new-goal.txt", content: "NEW_GOAL" } }] };
    if (system.includes("NEW_GOAL")) return { events: [{ type: "message", to: "user", text: "NEW_WRITE_DONE" }] };
    return { events: [{ type: "spawn", parent: "pm", child: "worker-slow", role: "Worker", goal: "OLD_GOAL", dispatch }, { type: "message", to: "user", text: "WORK_STARTED" }] };
  });
  const h = handlers(), replies: string[] = [];
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "OLD_GOAL", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => fs.existsSync(started));
    h.runtime.agents.get("pm")!.receiveUserInput("progress?");
    await until(() => replies.includes("STILL_RESPONSIVE"));
    assert.equal(sessionJournal().current("pm")!.revision, 1);
    h.runtime.agents.get("pm")!.receiveUserInput("/revise NEW_GOAL");
    await until(() => replies.includes("NEW_WRITE_DONE"));
    assert.equal(fs.readFileSync("new-goal.txt", "utf8"), "NEW_GOAL");
    const oldPid = Number(fs.readFileSync(started, "utf8"));
    assert.throws(() => process.kill(oldPid, 0), "old command process must be gone before new writes finish");
    assert.equal(sessionJournal().binding("worker-slow")!.status, "superseded");
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(fs.existsSync(obsolete), false);
    const calls = fs.readFileSync(sessionJournal().file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(calls.filter((e) => e.kind === "runtime.event" && e.data.type === "tool.call" && e.data.id === "new-write").length, 1, "obsolete foreground completion must not restart the new task");
  } finally { h.stop(); await server.stop(); }
});

test("overflow inbox survives restart and is acknowledged only after durable admission", () => {
  let j = sessionJournal();
  j.append("inbox.received", "pm", "pm", 0, { id: "delivery-id", text: "queued question?", channel: "feishu", metadata: { openId: "local-test" } });
  j = new SessionJournal(root);
  assert.equal(j.queued("feishu").length, 1);
  sessionJournal().bind("pm", "Leader");
  acceptSessionInput("pm", "queued question?", "delivery-id");
  assert.equal(new SessionJournal(root).queued("feishu").length, 0);
  assert.equal(new SessionJournal(root).pending("pm")[0]!.id, "delivery-id");
});

test("interrupted tool calls cannot be blindly replayed and completed IDs are idempotent", async () => {
  const j = sessionJournal(); j.bind("pm", "Leader"); acceptSessionInput("pm", "创建文件", "one");
  const args = { path: "uncertain.txt", content: "unknown" };
  j.append("runtime.event", "pm", "pm", 1, { type: "tool.call", id: "interrupted", name: "Write", args });
  j.append("session.recovered", "pm", "pm", 1, {});
  j.append("runtime.event", "pm", "pm", 1, { type: "tool.call", id: "interrupted", name: "Write", args });
  assert.equal((await executeTool("Write", args, { agentId: "pm", revision: 1, callId: "interrupted" })).code, "uncertain_effect");
  assert.equal(fs.existsSync("uncertain.txt"), false);
  const fresh = { path: "completed.txt", content: "first" };
  j.append("runtime.event", "pm", "pm", 1, { type: "tool.call", id: "completed", name: "Write", args: fresh });
  assert.equal((await executeTool("Write", fresh, { agentId: "pm", revision: 1, callId: "completed" })).ok, true);
  fs.writeFileSync("completed.txt", "external edit");
  j.append("runtime.event", "pm", "pm", 1, { type: "tool.call", id: "completed", name: "Write", args: fresh });
  assert.equal((await executeTool("Write", fresh, { agentId: "pm", revision: 1, callId: "completed" })).ok, true);
  assert.equal(fs.readFileSync("completed.txt", "utf8"), "external edit");
  assert.equal((await executeTool("Write", { ...fresh, content: "different" }, { agentId: "pm", revision: 1, callId: "completed" })).code, "call_id_conflict");
});
