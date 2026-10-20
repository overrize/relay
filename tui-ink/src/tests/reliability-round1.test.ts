// Historical shared-workspace regression contract; round7 tests exercise the new default snapshot mode.
process.env.SPAWN_WORKSPACE_ISOLATION = "shared";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLLMServer } from "./e2e/driver/MockLLMServer.js";

const originalCwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-reliability-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
process.chdir(scratch);
const { createMemory, loadMemory, loadMessages, saveMemory } = await import("../memory/MemoryStore.js");
const { SecretaryProxy } = await import("../memory/SecretaryProxy.js");
const { initSecretary, destroySecretary, buildResumeContext } = await import("../runtime/MemoryRuntime.js");
const { applyEvent, ensureAgent, getState, _resetForTest } = await import("../store.js");
const { HttpConvAgent } = await import("../adapters/httpAgent.js");
const { executeTool, cancelAgentTools } = await import("../tools/registry.js");
const { ProcessManager } = await import("../pm/ProcessManager.js");
const { estimateTokens } = await import("../context/tokens.js");
const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
const { feishuMsgQueue } = await import("../runtime/FeishuBridge.js");
const { writeSnapshot } = await import("../memory/atomic.js");
const dispatch = { background: "reliability regression", constraints: [], acceptance_criteria: ["verified"], stop_conditions: ["agent.done"] };
const params = (agentId: string) => ({ agentId, agentType: "PM" as const, parentChain: [], depth: 0, model: "mock", roleName: "PM" });
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out waiting for runtime"); await new Promise((r) => setTimeout(r, 10)); }
}
beforeEach(() => _resetForTest());
after(async () => { await (await import("../tools/command.js")).cancelAllAgentTools(); process.chdir(originalCwd); }); // Keep process lifecycle evidence in the test TEMP directory.

test("store-accepted tool results update secretary once and clear pending operations", () => {
  const map = new Map<string, InstanceType<typeof SecretaryProxy>>();
  const sec = initSecretary(map, "wired", undefined, () => params("wired"));
  applyEvent({ v: 1, type: "tool.call", agent: "wired", id: "read1", name: "Read", args: { path: "demo" } });
  applyEvent({ v: 1, type: "tool.result", agent: "wired", id: "read1", ok: true, output: "observed content" });
  destroySecretary(map, "wired");
  const mem = loadMemory("wired")!;
  assert.equal(mem.working_set.facts.length, 1);
  assert.equal(mem.working_set.facts[0]!.weight, 1);
  assert.equal(mem.tombstone.pending_tool_calls, undefined);
  assert.equal(sec.listenerCount("destroy"), 0);
});

test("opposite requirements remain distinct; exact repeats alone gain weight", () => {
  const sec = new SecretaryProxy(createMemory(params("conflict")));
  const yes = "企业账户必须启用 SSO 登录并保留邮箱登录作为备用入口";
  const no = "企业账户必须禁用 SSO 登录并保留邮箱登录作为备用入口";
  for (const [i, output] of [yes, no, yes].entries()) sec.observe({ v: 1, type: "tool.result", agent: "conflict", id: String(i), ok: true, output });
  assert.deepEqual(sec.getMemory().working_set.facts.map((f) => [f.text, f.weight]), [[yes, 2], [no, 1]]);
  sec.destroy();
});

test("merged fork messages survive a new HttpConvAgent instance", () => {
  const sec = new SecretaryProxy(createMemory(params("merged")));
  const cfg = { id: "merged", role: "Leader", providerCfg: { provider: "openai" as const, model: "mock", apiKey: "unused" } };
  const a = new HttpConvAgent(cfg);
  a.on("_raw_message", (m) => sec.observeMessage(m.role, m.content));
  a.appendHistory([{ role: "user", content: "企业版改成 SSO" }, { role: "assistant", content: "保留个人版邮箱登录" }]);
  sec.destroy();
  const restored = new HttpConvAgent({ ...cfg, resumeFrom: "merged" });
  assert.deepEqual(restored.getMessages().map((m) => m.content), loadMessages("merged").map((m) => m.content));
  assert.equal(restored.getMessages().length, 2);
});

test("history and all resume sections respect their hard estimated budgets", () => {
  const messages = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const, content: "字".repeat(20000) }));
  const compact = HttpConvAgent.compactHistoryByTokens(messages, 100);
  assert.ok(compact.reduce((n, m) => n + estimateTokens(m.content), 0) <= 100);
  const mem = createMemory(params("bounded"));
  mem.dispatch.memory_quota_kb = 1;
  mem.working_set.decisions = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: "长期决定".repeat(100), rationale: "", ts: i }));
  mem.tombstone.last_todo = "invalid-json";
  saveMemory("bounded", mem);
  const context = buildResumeContext("bounded", "bounded", "PM", "");
  assert.ok(Buffer.byteLength(context) <= 1024);
  assert.ok(estimateTokens(context) <= 256);
});

test("adaptive can spawn a direct Worker, legacy hierarchy and single mode remain explicit", () => {
  ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
  const event = { v: 1 as const, type: "spawn" as const, parent: "pm", child: "direct", role: "Worker" as const, goal: "task", dispatch };
  for (const [mode, expected] of [["adaptive", true], ["hierarchical", false], ["single", false]] as const) {
    const pm = new ProcessManager(mode);
    try { assert.equal(pm.preCheckSpawn(event, "Leader").ok, expected); } finally { pm.destroy(); }
  }
});

test("shell work does not block messages and cancellation kills the process tree", async () => {
  const script = path.join(scratch, "slow.cjs"), marker = path.join(scratch, "finished");
  fs.writeFileSync(script, `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),3000)`);
  const pending = executeTool("Bash", { command: `"${process.execPath}" "${script}"` }, { agentId: "cancel-test" });
  let timerRan = false;
  await new Promise<void>((r) => setTimeout(() => { timerRan = true; r(); }, 100));
  assert.equal(timerRan, true);
  assert.equal(fs.existsSync(marker), false);
  cancelAgentTools("cancel-test");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.output, /cancelled/i);
  const next = await executeTool("Bash", { command: "echo usable-after-cancel" }, { agentId: "cancel-test" });
  assert.equal(next.ok, true);
  assert.match(next.output, /usable-after-cancel/);
});

test("real handlers: PM replies while direct Worker runs, tool facts reach both secretaries, fork persists", async () => {
  const mock = new MockLLMServer();
  const port = await mock.start();
  const runtime = createRuntimeContext();
  const replies: string[] = [];
  let releasedWhileWorking = false;
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({
    models: { mock: { provider: "openai", model: "mock", apiKey: "mock-only", baseUrl: `http://127.0.0.1:${port}` } },
    agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } },
  }));
  configureAgentHandlers({ ...runtime, MODEL: "mock", DEMO: false,
    buildSystemPrompt: (_role, id) => `**agent_id**: \`${id}\``,
    killAgent: (id) => { runtime.killedAgents.add(id); runtime.agents.get(id)?.kill(); },
  });
  const script = path.join(scratch, "working.cjs");
  fs.writeFileSync(script, "setTimeout(()=>console.log('WORKER_EVIDENCE'),900)");
  mock.enqueue(
    { agentId: "feishu-test", events: [{ type: "spawn", child: "direct-worker", parent: "feishu-test", role: "Worker", goal: "read evidence", dispatch }, { type: "message", to: "user", text: "working" }] },
    { agentId: "direct-worker", events: [{ type: "tool.call", id: "long-tool", name: "Bash", args: { command: `"${process.execPath}" "${script}"` } }] },
    { agentId: "feishu-test", events: [{ type: "message", to: "user", text: "PM_RESPONDED_DURING_WORK" }] },
    { agentId: "direct-worker", events: [{ type: "agent.done", success: true, reason: "read evidence" }] },
    { agentId: "feishu-test", events: [{ type: "message", to: "user", text: "worker verified" }] },
    { agentId: "fork-test", events: [{ type: "message", to: "user", text: "fork persisted" }] },
  );
  try {
    ensureAgent({ id: "feishu-test", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "feishu-test", firstMessage: "start", conversationMode: true, replyHook: (text) => {
      replies.push(text);
      if (text === "working") feishuMsgQueue.set("feishu-test", [{ text: "progress?", messageId: "followup" }]);
    },
      turnEndHook: () => { if (getState().agents.get("direct-worker")?.state !== "done") releasedWhileWorking = true; } });
    await until(() => !!loadMemory("direct-worker")?.tombstone.pending_tool_calls?.length && replies.includes("working"));
    await until(() => replies.includes("PM_RESPONDED_DURING_WORK"));
    assert.notEqual(getState().agents.get("direct-worker")?.state, "done");
    assert.equal(releasedWhileWorking, true, "Feishu turn-end must release the lock before the worker finishes");
    await until(() => getState().agents.get("direct-worker")?.state === "done");
    assert.equal(loadMemory("direct-worker")!.tombstone.pending_tool_calls, undefined);
    assert.ok(loadMemory("direct-worker")!.working_set.facts.some((f) => f.text.includes("WORKER_EVIDENCE")));
    assert.ok(runtime.secretaries.get("feishu-test")!.getMemory().working_set.facts.some((f) => f.text.includes("WORKER_EVIDENCE")));
    ensureAgent({ id: "fork-test", name: "fork", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "fork-test", firstMessage: "parallel question", isForkedTask: true, conversationMode: true, replyHook: (text) => replies.push(text) });
    await until(() => replies.includes("fork persisted"));
    assert.equal(loadMessages("fork-test").length, 2);
    assert.ok(loadMemory("fork-test"));
  } finally {
    for (const agent of runtime.agents.values()) agent.kill();
    for (const sec of runtime.secretaries.values()) sec.destroy();
    runtime.pm.destroy();
    await mock.stop();
  }
});


test("failed snapshot publication keeps the previous snapshot intact", (t) => {
  const file = path.join(scratch, "atomic.json");
  writeSnapshot(file, '{"version":1}');
  t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); });
  assert.throws(() => writeSnapshot(file, '{"version":2}'), /locked/);
  assert.equal(fs.readFileSync(file, "utf8"), '{"version":1}');
  assert.equal(fs.readdirSync(scratch).some((f) => f.endsWith(".tmp")), false);
});
