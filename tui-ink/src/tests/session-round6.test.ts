// Historical shared-workspace regression contract; round7 tests exercise the new default snapshot mode.
process.env.SPAWN_WORKSPACE_ISOLATION = "shared";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const original = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round6-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
const { SessionJournal, sessionJournal } = await import("../session/Journal.js");
const { admitWorker, taskFor, workItems, taskState, reserveAttempt, consumeTaskTurn, consumeTaskRequest, beginTaskOperation, finishTaskOperation, safeToRetry } = await import("../session/Tasks.js");
const { retryTask, reviewTask, taskMode, reconcileTask, recordTaskCancellation, queueTaskResolution, waitTaskResolution, stopTaskRecovery } = await import("../runtime/TaskRecovery.js");
const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
const { applyEvent, ensureAgent, _resetForTest } = await import("../store.js");
const { executeTool } = await import("../tools/registry.js");
const { cancelAllAgentTools } = await import("../tools/command.js");
const { releaseRuntimeOwners } = await import("../session/RuntimeOwner.js");
const { restoreBackup } = await import("../session/Backup.js");
const { waitForIndexing } = await import("../session/SearchIndex.js");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); _resetForTest(); });
afterEach(async () => { stopTaskRecovery(); await waitTaskResolution(); await waitForIndexing(); releaseRuntimeOwners(); process.chdir(original); });
const dispatch = { background: "round six", constraints: [], acceptance_criteria: ["final file content"], stop_conditions: ["agent.done"] };
function seed(extra: Record<string, unknown> = {}) {
  const j = sessionJournal(); j.bind("pm", "Leader");
  const e = { v: 1 as const, type: "spawn" as const, parent: "pm", child: "worker", role: "Worker" as const, goal: "same logical goal", dispatch: { ...dispatch, ...extra } };
  admitWorker(e); applyEvent(e); return { j, e, t: taskFor("worker")! };
}
function stopped(agent = "worker", success = false, reason = "retryable: interrupted", evidence: string[] = []) { applyEvent({ v: 1, type: "agent.done", agent, success, reason, evidence }); }
// CI Windows runners can take several seconds per durable retry; this is a
// harness deadline, not an increase to production attempts or retry budgets.
async function until(f: () => boolean, timeout = process.env.CI && process.platform === "win32" ? 45000 : 9000) { const end = Date.now() + timeout; while (!f()) { if (Date.now() > end) throw new Error("round6 runtime timeout"); await new Promise((r) => setTimeout(r, 10)); } }
async function runtime(reply: (id: string, body: any, n: number) => any[] | { status: number }) {
  const requests: any[] = [], counts = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()), id = /agent_id\*\*: `([^`]+)`/.exec(body.messages[0].content)?.[1] ?? "unknown";
    requests.push({ id, body }); const n = (counts.get(id) ?? 0) + 1; counts.set(id, n);
    const events = reply(id, body, n);
    if (!Array.isArray(events)) { res.writeHead(events.status); res.end("fixture HTTP failure"); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: events.map((e) => JSON.stringify(e)).join("\n") } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local-only", baseUrl: `http://127.0.0.1:${(server.address() as any).port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  const r = createRuntimeContext(); configureAgentHandlers({ ...r, MODEL: "mock", DEMO: false, buildSystemPrompt: (_role, id) => `**agent_id**: \`${id}\``, killAgent: (id) => { r.killedAgents.add(id); r.agents.get(id)?.kill(); } });
  return { r, requests, stop: async () => { stopTaskRecovery(); for (const [id, a] of r.agents) { r.killedAgents.add(id); a.kill(); } for (const s of r.secretaries.values()) s.destroy(); r.pm.destroy(); await waitTaskResolution(); stopTaskRecovery(); await cancelAllAgentTools(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
const check = { criterion: 0, type: "file_contains" as const, path: "result.txt", value: "FINAL" };

test("auto continuation shares budgets, reuses verified writes and independently accepts final content while PM responds", async () => {
  const h = await runtime((id, body, n) => {
    if (id === "pm") return n === 1 ? [{ type: "spawn", parent: "pm", child: "worker", role: "Worker", goal: "finish result file", dispatch: { ...dispatch, acceptance_checks: [check] } }, { type: "message", to: "user", text: "STARTED" }] : [{ type: "message", to: "user", text: String(body.messages.at(-1).content).includes("progress?") ? "PM_RESPONSIVE" : "PM_ACK" }];
    if (id === "worker") return n === 1 ? [{ type: "tool.call", id: "write", name: "Write", args: { path: "result.txt", content: "PARTIAL" } }] : [{ type: "agent.done", success: false, reason: "retryable: finish remaining replacement" }];
    if (n === 1) return [{ type: "tool.call", id: "same-write", name: "Write", args: { path: "result.txt", content: "PARTIAL" } }];
    if (n === 2) return [{ type: "tool.call", id: "finish", name: "Edit", args: { path: "result.txt", old_string: "PARTIAL", new_string: "FINAL" } }];
    return [{ type: "agent.done", success: true, reason: "final checked", evidence: ["result.txt"] }];
  });
  const replies: string[] = [];
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "finish file", conversationMode: true, replyHook: (s) => replies.push(s) });
    await until(() => workItems()[0]?.status === "retry_wait"); h.r.agents.get("pm")!.receiveUserInput("progress?");
    await until(() => replies.includes("PM_RESPONSIVE")); await until(() => workItems()[0]?.status === "accepted");
    const t = workItems()[0]!; assert.equal(t.attempts.length, 2); assert.equal(t.usedTurns, 5); assert.equal(t.usedTools, 2);
    assert.equal(fs.readFileSync("result.txt", "utf8"), "FINAL"); assert.equal(t.verdict?.reviewer, "runtime-file-checks");
    const logs = fs.readFileSync(sessionJournal().file, "utf8"); assert.match(logs, /Verified completed operation/);
    assert.deepEqual(t.attempts, ["worker", "worker-retry-2"]);
    assert.throws(() => admitWorker({ v: 1, type: "spawn", parent: "pm", child: "different-id", role: "Worker", goal: t.goal, dispatch }), /already exists/);
  } finally { await h.stop(); }
});

test("false success cannot pass file checks; repeated failure consumes a finite retry budget", async () => {
  const h = await runtime((id, _body, n) => id === "pm" ? n === 1 ? [{ type: "spawn", parent: "pm", child: "worker", role: "Worker", goal: "wrong output", dispatch: { ...dispatch, acceptance_checks: [check] } }, { type: "message", to: "user", text: "STARTED" }] : [{ type: "message", to: "user", text: "ACK" }] : n === 1 ? [{ type: "tool.call", id: "write", name: "Write", args: { path: "result.txt", content: "WRONG" } }] : [{ type: "agent.done", success: true, reason: "pretend done" }]);
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" }); startLeaderAgent({ id: "pm", firstMessage: "run", conversationMode: true });
    await until(() => workItems()[0]?.status === "exhausted"); const t = workItems()[0]!;
    assert.equal(t.attempts.length, 2); assert.equal(t.verdict?.passed, false); assert.match(t.verdict!.details.join(" "), /FAIL/);
    await new Promise((r) => setTimeout(r, 650)); assert.equal(workItems()[0]!.attempts.length, 2);
    assert.throws(() => retryTask("pm", t.id, "try once more"), /exhausted/);
  } finally { await h.stop(); }
});

test("successful shell effects and interrupted writes block automatic replay", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t } = seed(); const bash = await executeTool("Bash", { command: "echo observed" }, { agentId: "worker", callId: "shell" }); assert.equal(bash.ok, true);
    stopped(); queueTaskResolution("worker"); await waitTaskResolution(); assert.match(workItems()[0]!.reason, /effect-needs-inspection:Bash/);
    retryTask("pm", t.id, "repeat blindly"); assert.equal(workItems()[0]!.status, "blocked");
    const op = beginTaskOperation("worker", "uncertain", "Write", { path: "unknown.txt", content: "x" });
    assert.ok(op.blocked); // A stopped task cannot start more operations.
  } finally { await h.stop(); }
});

test("revision changes fence a durable retry waiting in backoff", async () => {
  const h = await runtime((id, _body, n) => id === "pm" ? n === 1 ? [{ type: "spawn", parent: "pm", child: "worker", role: "Worker", goal: "obsolete", dispatch: { ...dispatch, acceptance_checks: [check] } }, { type: "message", to: "user", text: "STARTED" }] : [{ type: "message", to: "user", text: "NEW_GOAL_ACK" }] : [{ type: "agent.error", code: "http_error", detail: "HTTP 503 fixture" }]);
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" }); startLeaderAgent({ id: "pm", firstMessage: "OLD_GOAL", conversationMode: true });
    await until(() => workItems()[0]?.status === "retry_wait"); h.r.agents.get("pm")!.receiveUserInput("/revise NEW_GOAL");
    await until(() => sessionJournal().currentRevision("pm") === 2); await new Promise((r) => setTimeout(r, 800));
    assert.equal(workItems()[0]!.status, "superseded"); assert.equal(h.requests.some((r) => r.id === "worker-retry-2"), false);
  } finally { await h.stop(); }
});

test("manual policy pauses dispatch and cannot reset shared attempt, turn or tool budgets", () => {
  const { t } = seed({ recovery: { mode: "manual", max_attempts: 2, max_turns: 1, max_tools: 1 } });
  assert.equal(consumeTaskTurn("worker"), true); assert.equal(consumeTaskTurn("worker"), false);
  assert.throws(() => reserveAttempt(t, "another"), /budget exhausted/);
  assert.equal(workItems()[0]!.status, "exhausted"); assert.equal(taskMode("pm", t.id, "auto").usedTurns, 1);
  assert.throws(() => reserveAttempt(t, "yet-another"), /budget exhausted/);
});

test("one conversation budget prevents changing goal text to escape retry limits", () => {
  process.env.SPAWN_TASK_ATTEMPTS_PER_REVISION = "2";
  try {
    seed();
    for (let i = 0; i < 2; i++) {
      const e = { v: 1 as const, type: "spawn" as const, parent: "pm", child: `other-${i}`, role: "Worker" as const, goal: `new label ${i}`, dispatch };
      if (i === 0) admitWorker(e); else assert.throws(() => admitWorker(e), /budget exhausted/);
    }
    assert.equal(workItems().reduce((n, t) => n + t.attempts.length, 0), 2);
  } finally { delete process.env.SPAWN_TASK_ATTEMPTS_PER_REVISION; }
});

test("research/review profiles enforce read tools without adding a manager layer", async () => {
  const { t } = seed({ worker_profile: "review" }); fs.writeFileSync("evidence.txt", "original");
  const denied = await executeTool("Write", { path: "evidence.txt", content: "changed" }, { agentId: "worker", callId: "write" });
  assert.equal(denied.code, "task_control_blocked"); assert.equal(fs.readFileSync("evidence.txt", "utf8"), "original");
  assert.equal((await executeTool("Read", { path: "evidence.txt" }, { agentId: "worker", callId: "read" })).ok, true);
  assert.equal(workItems()[0]!.profile, t.profile);
});

test("independent acceptance requires fresh PM proof and cannot accept failing deterministic checks", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t, j } = seed(); fs.writeFileSync("result.txt", "FINAL");
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "old-read", name: "Read", args: { path: "result.txt" } }); await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "old-read" });
    stopped("worker", true, "done"); queueTaskResolution("worker"); await waitTaskResolution(); assert.equal(workItems()[0]!.status, "awaiting_review");
    assert.throws(() => reviewTask("worker", t.id, "accept", ["old-read"], "self approve"), /Only the current task owner/);
    assert.throws(() => reviewTask("pm", t.id, "accept", ["old-read"], "stale evidence"), /fresh/);
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "fresh-read", name: "Read", args: { path: "result.txt" } }); await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "fresh-read" });
    assert.equal(reviewTask("pm", t.id, "accept", ["fresh-read"], "checked final content against criteria").status, "accepted");
    assert.equal(new SessionJournal(root).current("pm")!.work![t.id]!.verdict!.reviewer, "pm"); assert.ok(j.current("pm")!.work);
  } finally { await h.stop(); }
});

test("durable attempts, operation receipts and retry policy survive archive backup and a fresh Node process", async () => {
  const { t, j } = seed(); fs.writeFileSync("result.txt", "PARTIAL");
  const op = beginTaskOperation("worker", "write", "Write", { path: "result.txt", content: "PARTIAL" }); finishTaskOperation("worker", op.key!, "Write", { path: "result.txt", content: "PARTIAL" }, { ok: true, output: "written" });
  stopped(); taskState(t, { status: "retry_wait", nextAt: Date.now() + 60000, reason: "retryable: interrupted" });
  await j.maintain({ maxLogBytes: 0, retentionMs: 0 }); const expected = j.current("pm")!.work;
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href, url = new URL("../session/Journal.ts", import.meta.url).href;
  const child = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", `import {SessionJournal} from ${JSON.stringify(url)};console.log(JSON.stringify(new SessionJournal().current('pm').work))`], { cwd: root });
  assert.deepEqual(JSON.parse(child.stdout), JSON.parse(JSON.stringify(expected)));
  const target = path.join(scratch, "restored-" + path.basename(root)); await restoreBackup(root, target);
  assert.deepEqual(new SessionJournal(target).current("pm")!.work, expected);
});

test("unknown or changed file effects are blocked even across fresh Worker IDs", () => {
  const { t } = seed(); const op = beginTaskOperation("worker", "write", "Write", { path: "result.txt", content: "PARTIAL" });
  assert.match(safeToRetry(workItems()[0]!)!, /effect-needs-inspection/);
  fs.writeFileSync("result.txt", "PARTIAL"); finishTaskOperation("worker", op.key!, "Write", { path: "result.txt" }, { ok: true, output: "done" });
  assert.equal(safeToRetry(workItems()[0]!), undefined); fs.writeFileSync("result.txt", "external-change"); assert.match(safeToRetry(workItems()[0]!)!, /effect-changed/);
  assert.equal(t.maxAttempts, 2);
});

test("PM reconciliation requires fresh evidence and lets the next attempt skip the inspected command", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t, e } = seed(); await executeTool("Bash", { command: "echo observed", timeout: 1000 }, { agentId: "worker", callId: "shell" });
    stopped(); queueTaskResolution("worker"); await waitTaskResolution();
    assert.throws(() => reconcileTask("pm", t.id, "worker:shell", ["missing"], "inspected"), /fresh/);
    fs.writeFileSync("inspection.txt", "observed result; do not repeat");
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "inspect", name: "Read", args: { path: "inspection.txt" } }); await executeTool("Read", { path: "inspection.txt" }, { agentId: "pm", callId: "inspect" });
    reconcileTask("pm", t.id, "worker:shell", ["inspect"], "checked actual outcome; only complete remaining work");
    assert.equal(safeToRetry(workItems()[0]!), undefined);
    reserveAttempt(workItems()[0]!, "next"); applyEvent({ ...e, child: "next" });
    const result = await executeTool("Bash", { command: "echo observed", timeout: 2000 }, { agentId: "next", callId: "repeat" });
    assert.equal(result.ok, true); assert.match(result.output, /DO NOT REPEAT/);
    assert.equal(workItems()[0]!.usedTools, 1); assert.equal(new SessionJournal(root).current("pm")!.work![t.id]!.operations["worker:shell"]!.reconciliation!.reviewer, "pm");
  } finally { await h.stop(); }
});

test("manual policy preserves a pending request but blocks it until explicitly resumed", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t } = seed({ recovery: { mode: "manual" } }); stopped(); queueTaskResolution("worker"); await waitTaskResolution();
    assert.equal(retryTask("pm", t.id, "inspect then use a different strategy").status, "retry_wait");
    taskMode("pm", t.id, "manual"); await new Promise((r) => setTimeout(r, 700));
    assert.equal(workItems()[0]!.attempts.length, 1); assert.equal(workItems()[0]!.retryRequested, false);
    assert.equal(taskMode("pm", t.id, "auto").maxAttempts, 2);
  } finally { await h.stop(); }
});

test("HTTP transport retries also consume the persistent request budget", async () => {
  const h = await runtime((id, _body, n) => id === "pm" ? n === 1 ? [{ type: "spawn", parent: "pm", child: "worker", role: "Worker", goal: "bounded network", dispatch: { ...dispatch, recovery: { max_requests: 1 } } }, { type: "message", to: "user", text: "STARTED" }] : [{ type: "message", to: "user", text: "ACK" }] : { status: 503 });
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" }); startLeaderAgent({ id: "pm", firstMessage: "run", conversationMode: true });
    await until(() => workItems()[0]?.status === "exhausted", 10000);
    const t = workItems()[0]!; assert.equal(t.usedRequests, 1); assert.equal(t.attempts.length, 1); assert.equal(h.requests.filter((r) => r.id === "worker").length, 1);
  } finally { await h.stop(); }
});

test("expired deadlines and cancelled tasks cannot automatically restart", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t } = seed(); recordTaskCancellation("worker", "user cancelled execution"); await waitTaskResolution();
    assert.equal(workItems()[0]!.status, "blocked"); assert.match(workItems()[0]!.reason, /non-retryable/); assert.equal(workItems()[0]!.attempts.length, 1);
    taskState(t, { status: "running", deadline: Date.now() - 1 });
    assert.equal(consumeTaskTurn("worker"), false); assert.equal(consumeTaskRequest("worker"), false);
    assert.throws(() => reserveAttempt(workItems()[0]!, "next"), /budget exhausted/);
  } finally { await h.stop(); }
});

test("manual acceptance cannot override a failing contract and all criteria need coverage", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t } = seed({ recovery: { mode: "manual" }, acceptance_checks: [check] }); fs.writeFileSync("result.txt", "WRONG"); stopped("worker", true, "claims complete"); queueTaskResolution("worker"); await waitTaskResolution();
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "read", name: "Read", args: { path: "result.txt" } }); await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "read" });
    assert.throws(() => reviewTask("pm", t.id, "accept", ["read"], "ignore mismatch"), /Cannot override/);
    assert.equal(reviewTask("pm", t.id, "reject", ["read"], "content is wrong").status, "blocked");
    assert.equal(workItems()[0]!.attempts.length, 1);
  } finally { await h.stop(); }
});

test("runtime acceptance runs a real test suite independently and requires parsed passing tests", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    fs.writeFileSync("package.json", JSON.stringify({ scripts: { test: "node --test verification.test.cjs" } }));
    fs.writeFileSync("verification.test.cjs", "const {test}=require('node:test');const assert=require('node:assert/strict');test('actual artifact',()=>assert.equal(require('fs').readFileSync('result.txt','utf8'),'FINAL'));");
    const { t } = seed({ acceptance_criteria: ["content", "test passes"], acceptance_checks: [check, { criterion: 1, type: "test_suite", path: "." }] });
    await executeTool("Write", { path: "result.txt", content: "FINAL" }, { agentId: "worker", callId: "write" }); stopped("worker", true, "done"); queueTaskResolution("worker"); await waitTaskResolution();
    const result = workItems()[0]!; assert.equal(result.status, "accepted"); assert.ok(result.verdict!.details.some((d) => /PASS criterion=1 test_suite/.test(d)));
    assert.equal(sessionJournal().current("pm")!.tools[`pm:accept-${t.id}-1-1`]!.ok, true);
  } finally { await h.stop(); }
});

test("empty successful commands do not count as independent test acceptance", async () => {
  fs.writeFileSync("package.json", JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  const result = await executeTool("RunTests", { project_dir: ".", strict: true }); assert.equal(result.ok, false); assert.match(result.output, /at least one parsed passing test/);
});

test("verify profile may run tests but cannot edit the implementation", async () => {
  seed({ worker_profile: "verify" });
  const result = await executeTool("Write", { path: "forbidden.txt", content: "x" }, { agentId: "worker", callId: "write" });
  assert.equal(result.code, "task_control_blocked"); assert.equal(fs.existsSync("forbidden.txt"), false);
});

test("interrupted acceptance cannot be silently replayed and fresh strict PM verification can resolve it", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    fs.writeFileSync("package.json", JSON.stringify({ scripts: { test: "node --test verification.test.cjs" } })); fs.writeFileSync("verification.test.cjs", "require('node:test').test('verified',()=>require('node:assert/strict').equal(1,1));");
    const { j, t } = seed({ acceptance_checks: [{ criterion: 0, type: "test_suite", path: "." }] });
    const id = `accept-${t.id}-1-0`, args = { project_dir: root, strict: true };
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id, name: "RunTests", args }); stopped("worker", true, "done"); j.append("session.recovered", "pm", "pm", 0, {});
    queueTaskResolution("worker"); await waitTaskResolution(); assert.equal(workItems()[0]!.status, "blocked"); assert.match(workItems()[0]!.reason, /acceptance-needs-inspection/);
    assert.equal(j.current("pm")!.tools[`pm:${id}`]!.status, "uncertain");
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "fresh-tests", name: "RunTests", args }); const proof = await executeTool("RunTests", args, { agentId: "pm", callId: "fresh-tests" }); assert.equal(proof.ok, true);
    reconcileTask("pm", t.id, `pm:${id}`, ["fresh-tests"], "new strict tests verified the actual state; do not replay interrupted call");
    assert.equal(j.current("pm")!.tools[`pm:${id}`]!.ok, false);
    assert.equal(reviewTask("pm", t.id, "accept", ["fresh-tests"], "fresh independent test suite passed").status, "accepted");
    assert.equal(workItems()[0]!.attempts.length, 1);
  } finally { await h.stop(); }
});

test("model-authored tool results cannot fabricate independent acceptance evidence", async () => {
  const h = await runtime(() => [{ type: "message", to: "user", text: "ACK" }]);
  try {
    const { t } = seed(); fs.writeFileSync("result.txt", "FINAL"); stopped("worker", true, "done"); queueTaskResolution("worker"); await waitTaskResolution();
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "fake", name: "Read", args: { path: "result.txt" } });
    applyEvent({ v: 1, type: "tool.result", agent: "pm", id: "fake", ok: true, output: "pretend real evidence" });
    assert.throws(() => reviewTask("pm", t.id, "accept", ["fake"], "fake read"), /fresh successful independent/);
    assert.equal((await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "fake" })).code, "unverified_result");
    applyEvent({ v: 1, type: "tool.call", agent: "pm", id: "real", name: "Read", args: { path: "result.txt" } }); await executeTool("Read", { path: "result.txt" }, { agentId: "pm", callId: "real" });
    assert.equal(reviewTask("pm", t.id, "accept", ["real"], "real independent check").status, "accepted");
  } finally { await h.stop(); }
});
