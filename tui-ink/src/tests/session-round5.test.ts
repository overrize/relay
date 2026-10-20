// Historical shared-workspace regression contract; round7 tests exercise the new default snapshot mode.
process.env.SPAWN_WORKSPACE_ISOLATION = "shared";
import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionJournal, sessionJournal } from "../session/Journal.js";
import { backupDirectory, listBackups, verifyBackups, repairArchives, restoreBackup } from "../session/Backup.js";
import { waitForIndexing } from "../session/SearchIndex.js";
import { registerRuntimeOwner, releaseRuntimeOwners } from "../session/RuntimeOwner.js";



import { MockLLMServer } from "./e2e/driver/MockLLMServer.js";




const original = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round5-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
const { taskNotice } = await import("../runtime/TaskNotice.js");
const { _resetForTest, ensureAgent, getState, applyEvent } = await import("../store.js");
const { ProcessManager } = await import("../pm/ProcessManager.js");
const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
const { cancelAllAgentTools } = await import("../tools/command.js");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); _resetForTest(); });
afterEach(async () => { await waitForIndexing(); releaseRuntimeOwners(); process.chdir(original); });
after(() => {}); // Preserve crash evidence on the configured test volume.
const policy = { maxLogBytes: 0, retentionMs: 0, maxIndexBytes: 4 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };
function seed(j: SessionJournal, count = 20) {
  j.bind("pm", "Leader");
  j.append("requirement.changed", "pm", "pm", 1, { text: "CURRENT_GOAL" });
  for (let i = 0; i < count; i++) j.append("message.recorded", "pm", "pm", 1, { role: "user", content: i === 0 ? "EARLY_EVIDENCE 北京需求" : `routine_${i} ` + "padding ".repeat(80) });
  j.bind("worker", "Worker", "pm", "implement");
  j.append("runtime.event", "pm", "worker", 1, { type: "todo.set", items: [{ id: "one", text: "remaining verification", state: "todo" }] });
  j.append("runtime.event", "pm", "worker", 1, { type: "agent.done", success: false, reason: "budget", evidence: ["checked file"] });
  j.acceptNotice("pm", "notice", "WORKER_HANDOFF", 1);
}

test("live backup freezes active tail and restores goals, task handoff and pending notices", async () => {
  const j = new SessionJournal(root, { segmentBytes: 4096 }); seed(j);
  const before = j.current("pm"), sequence = j.sequence(), bytes = fs.statSync(j.file).size;
  const backup = await j.backup(); assert.equal(fs.statSync(j.file).size, bytes);
  j.append("requirement.changed", "pm", "pm", 2, { text: "NEWER_GOAL" });
  const target = path.join(scratch, "restore-" + path.basename(root));
  const result = await restoreBackup(root, target); assert.equal(result.seq, sequence.seq);
  assert.ok("id" in result); assert.equal(result.id, backup.id); assert.deepEqual(new SessionJournal(target).current("pm"), before);
  const restored = new SessionJournal(target);
  assert.equal(restored.pending("pm")[0]!.text, "WORKER_HANDOFF"); assert.equal(restored.pending("worker").length, 0);
  assert.deepEqual(restored.binding("worker")!.outcome?.remaining, ["remaining verification"]);
  assert.match((await restored.search("pm", "EARLY_EVIDENCE"))[0]!.excerpt, /北京需求/);
  assert.equal((await verifyBackups(root)).every((r) => r.valid), true);
  await assert.rejects(restoreBackup(root, target), /already has event data/);
});

test("exact archive repair preserves a newer goal and unarchived tail", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); seed(j); const report = await j.maintain(policy);
  assert.deepEqual(report.errors, []); assert.ok(report.backup);
  j.append("requirement.changed", "pm", "pm", 2, { text: "DO_NOT_ROLL_BACK" });
  j.append("message.recorded", "pm", "pm", 2, { role: "user", content: "NEW_TAIL" });
  const expected = j.current("pm"), dir = path.join(root, ".spawn/events/memory"), name = fs.readdirSync(dir)[0]!;
  fs.writeFileSync(path.join(dir, name), "corruption");
  assert.throws(() => new SessionJournal(root), /archive|memory/i);
  const result = await repairArchives(root); assert.deepEqual(result.repaired, [name]); assert.equal(result.goalRolledBack, false);
  const fixed = new SessionJournal(root); assert.deepEqual(fixed.current("pm"), expected);
  assert.match((await fixed.search("pm", "EARLY_EVIDENCE"))[0]!.excerpt, /EARLY_EVIDENCE/);
  assert.match((await fixed.search("pm", "NEW_TAIL"))[0]!.excerpt, /NEW_TAIL/);
});

test("corrupt latest backup falls back explicitly; a live workspace refuses restore and repair", async () => {
  const j = new SessionJournal(root); seed(j, 2); const first = await j.backup();
  j.append("message.recorded", "pm", "pm", 1, { role: "user", content: "only in newest" }); await j.backup();
  const all = await listBackups(root), firstRefs = new Set(all[1]!.files.map((f) => f.sha));
  const unique = all[0]!.files.find((f) => !firstRefs.has(f.sha))!;
  fs.writeFileSync(path.join(backupDirectory(root), "objects", `${unique.sha}.blob`), "bad");
  assert.equal((await verifyBackups(root))[0]!.valid, false);
  const target = path.join(scratch, "fallback-" + path.basename(root)), result = await restoreBackup(root, target);
  assert.ok("fallback" in result); assert.equal(result.fallback, true); assert.equal(result.id, first.id);
  registerRuntimeOwner(target);
  await assert.rejects(restoreBackup(root, target, { replace: true }), /Stop the running application/);
  await assert.rejects(repairArchives(target), /Stop the running application/);
});

test("failed backup keeps retired raw logs available for recovery", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); seed(j);
  const directory = backupDirectory(root); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "backup.lock"), String(process.pid));
  const report = await j.maintain(policy);
  assert.ok(report.errors.some((e) => /backup/i.test(e))); assert.ok(report.logBytes > 0);
  assert.equal(new SessionJournal(root).current("pm")!.goal, "CURRENT_GOAL");
  fs.unlinkSync(path.join(directory, "backup.lock"));
  assert.equal((await j.maintain(policy)).logBytes, 0);
});

test("interrupted restore fails closed and resumes after the original directory was moved", async () => {
  const j = new SessionJournal(root); seed(j, 2); await j.backup();
  const target = path.join(scratch, "crash-" + path.basename(root)); const old = new SessionJournal(target); old.bind("old", "Leader");
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href;
  const backupUrl = new URL("../session/Backup.ts", import.meta.url).href;
  const script = `import fs from 'node:fs';import {restoreBackup} from ${JSON.stringify(backupUrl)};const rename=fs.promises.rename;fs.promises.rename=async(a,b)=>{await rename(a,b);if(String(b).includes('events.before-restore-'))process.exit(23)};await restoreBackup(${JSON.stringify(root)},${JSON.stringify(target)},{replace:true});`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { cwd: root }), (e: any) => e.code === 23);
  assert.throws(() => new SessionJournal(target), /Interrupted restore/);
  const result = await restoreBackup(root, target, { replace: true }); assert.ok("resumedTransaction" in result); assert.equal(result.resumedTransaction, true);
  assert.equal(new SessionJournal(target).current("pm")!.goal, "CURRENT_GOAL");
  assert.ok(fs.readdirSync(path.join(target, ".spawn")).some((n) => n.startsWith("events.before-restore-")));
});

test("cold fallback is exact, queues at most two builds and persistent catalog skips many sources in a fresh process", async () => {
  const j = new SessionJournal(root, { segmentBytes: 1024 }); seed(j, 160);
  const first = await j.search("pm", "EARLY_EVIDENCE"); const cold = { ...j.lastSearch };
  assert.ok(first.length); assert.ok(cold.fallbackSources! > 30); assert.ok(cold.rebuildQueued! <= 2);
  await waitForIndexing();
  for (let i = 0; i < 4; i++) await j.maintain({ ...policy, maxLogBytes: 100 * 1024 * 1024, retentionMs: 86400000 });
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href, url = new URL("../session/Journal.ts", import.meta.url).href;
  const script = `import {SessionJournal} from ${JSON.stringify(url)};const j=new SessionJournal(${JSON.stringify(root)});const hits=await j.search('pm','EARLY_EVIDENCE');console.log(JSON.stringify({hits,stats:j.lastSearch}));`;
  const child = await promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { cwd: root });
  const warm = JSON.parse(child.stdout); assert.deepEqual(warm.hits, first);
  assert.ok(warm.stats.catalogSkipped > 50); assert.ok(warm.stats.sourcesVisited < 5); assert.ok(warm.stats.catalogBytesRead > 0);
  fs.writeFileSync(path.join(root, ".spawn/events/index/catalog.json.gz"), "bad");
  for (const term of ["EARLY_EVIDENCE", "北京", "routine_79"]) assert.deepEqual(await j.search("pm", term), await j.search("pm", term, 10, { useIndex: false }));
});

test("offline child handoff is durable, recipient-specific, deduplicated and revision fenced", () => {
  const j = sessionJournal(); seed(j, 1);
  taskNotice("pm", "worker", "STOPPED_VISIBLY", new Map(), new Set());
  taskNotice("pm", "worker", "STOPPED_VISIBLY", new Map(), new Set());
  assert.equal(j.pending("pm").filter((i) => i.text.includes("STOPPED_VISIBLY")).length, 1);
  assert.equal(j.pending("worker").length, 0);
  assert.match(new SessionJournal(root).pending("pm").at(-1)!.text, /remaining verification/);
  j.append("requirement.changed", "pm", "pm", 2, { text: "replacement goal" });
  taskNotice("pm", "worker", "STALE_RESULT", new Map(), new Set());
  assert.equal(j.pending("pm").some((i) => i.text.includes("STALE_RESULT")), false);
});

test("default dispatch is direct with at most one optional coordinator", () => {
  ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "run", depth: 0 });
  ensureAgent({ id: "tl", name: "TL", role: "Leader", state: "run", depth: 1, parent: "pm" });
  const pm = new ProcessManager("adaptive"), dispatch = { background: "test", constraints: [], acceptance_criteria: ["verified"], stop_conditions: ["agent.done"] };
  try {
    assert.equal(pm.preCheckSpawn({ v: 1, type: "spawn", parent: "pm", child: "w", role: "Worker", goal: "implement", dispatch }, "Leader").ok, true);
    const nested = pm.preCheckSpawn({ v: 1, type: "spawn", parent: "tl", child: "tl2", role: "Leader", goal: "coordinate", dispatch }, "Leader");
    assert.equal(nested.ok, false); assert.equal((nested as any).code, "adaptive_layer_limit");
  } finally { pm.destroy(); }
});

async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("runtime verification timed out"); await new Promise((r) => setTimeout(r, 10)); }
}
async function runtime() {
  const mock = new MockLLMServer(), port = await mock.start(), r = createRuntimeContext();
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local-only", baseUrl: `http://127.0.0.1:${port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  configureAgentHandlers({ ...r, MODEL: "mock", DEMO: false, buildSystemPrompt: (_role, id) => `**agent_id**: \`${id}\``, killAgent: (id) => { r.killedAgents.add(id); r.agents.get(id)?.kill(); } });
  return { mock, r, stop: async () => { for (const [id, a] of r.agents) { r.killedAgents.add(id); a.kill(); } for (const s of r.secretaries.values()) s.destroy(); r.pm.destroy(); await (await import("../runtime/TaskRecovery.js")).waitTaskResolution(); (await import("../runtime/TaskRecovery.js")).stopTaskRecovery(); await cancelAllAgentTools(); await mock.stop(); } };
}
const dispatch = { background: "runtime test", constraints: [], acceptance_criteria: ["verified"], stop_conditions: ["agent.done"] };

test("premature done cannot discard a queued Worker write; completed PM turn still receives the result", async () => {
  const h = await runtime(), replies: string[] = [];
  h.mock.enqueue(
    { agentId: "pm", events: [{ type: "spawn", parent: "pm", child: "w", role: "Worker", goal: "write evidence", dispatch }, { type: "message", to: "user", text: "WORKING" }] },
    { agentId: "w", startDelayMs: 150, events: [{ type: "tool.call", id: "write", name: "Write", args: { path: "actual-evidence.txt", content: "VERIFIED_WRITE" } }, { type: "agent.done", success: true, reason: "premature" }] },
    { agentId: "w", events: [{ type: "agent.done", success: true, reason: "tool result checked", evidence: ["actual-evidence.txt"] }] },
    { agentId: "pm", events: [{ type: "message", to: "user", text: "RESULT_RECEIVED" }] },
  );
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "write", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => replies.includes("WORKING"));
    applyEvent({ v: 1, type: "agent.done", agent: "pm", success: true });
    await until(() => replies.includes("RESULT_RECEIVED"));
    assert.equal(fs.readFileSync("actual-evidence.txt", "utf8"), "VERIFIED_WRITE");
    assert.equal(sessionJournal().binding("w")!.outcome?.reason, "tool result checked");
    assert.equal(sessionJournal().current("pm")!.tools["w:write"]!.status, "completed");
  } finally { await h.stop(); }
});

test("message-only Worker is bounded and leaves a durable failed handoff instead of silent idle", async () => {
  const h = await runtime(), replies: string[] = [];
  h.mock.enqueue(
    { agentId: "pm", events: [{ type: "spawn", parent: "pm", child: "w", role: "Worker", goal: "finish task", dispatch }, { type: "message", to: "user", text: "STARTED" }] },
    ...Array.from({ length: 3 }, () => ({ agentId: "w", events: [{ type: "message", to: "pm", text: "I will continue later" }] })),
    ...Array.from({ length: 6 }, () => ({ agentId: "pm", events: [{ type: "message", to: "user", text: "PM_ACK" }] })),
  );
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "start", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => sessionJournal().binding("w")?.status === "failed");
    await until(() => replies.includes("PM_ACK"));
    const outcome = new SessionJournal(root).binding("w")!.outcome!;
    assert.match(outcome.reason, /missing-terminal-report/); assert.equal(outcome.reportedSuccess, false);
    assert.ok(outcome.summary); assert.ok(outcome.remaining.length);
    assert.equal(h.mock.calls.filter((c) => c.agentId === "w").length, 3);
    await sessionJournal().maintain(policy);
    const target = path.join(scratch, "handoff-" + path.basename(root)); await restoreBackup(root, target);
    assert.deepEqual(new SessionJournal(target).binding("w")!.outcome, JSON.parse(JSON.stringify(outcome)));
  } finally { await h.stop(); }
});

test("a dead coordinator cannot swallow descendant handoff", () => {
  const j = sessionJournal(); j.bind("pm", "Leader"); j.bind("tl", "Leader", "pm", "coordinate"); j.bind("leaf", "Worker", "tl", "implement");
  j.append("runtime.event", "pm", "leaf", 0, { type: "agent.done", success: false, reason: "failed leaf" });
  taskNotice("tl", "leaf", "ESCALATED", new Map(), new Set(["tl"]));
  assert.equal(j.pending("tl").length, 0); assert.match(j.pending("pm")[0]!.text, /ESCALATED/);
});

test("exhausted model request becomes a durable failed task visible to PM", async () => {
  const h = await runtime(), replies: string[] = [];
  h.mock.enqueue(
    { agentId: "pm", events: [{ type: "spawn", parent: "pm", child: "w", role: "Worker", goal: "implement", dispatch }, { type: "message", to: "user", text: "STARTED" }] },
    { agentId: "w", events: [{ type: "agent.error", code: "http_error", detail: "HTTP 401 fixture" }] },
    { agentId: "pm", events: [{ type: "message", to: "user", text: "FAILURE_HANDLED" }] },
  );
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "start", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => replies.includes("FAILURE_HANDLED"));
    const outcome = new SessionJournal(root).binding("w")!.outcome!;
    assert.equal(outcome.reportedSuccess, false); assert.match(outcome.reason, /model-request-failed/);
    assert.match(outcome.lastError!, /401 fixture/); assert.equal(h.mock.calls.filter((c) => c.agentId === "w").length, 1);
  } finally { await h.stop(); }
});

test("snapshot retention keeps recovery points and corrupt local baselines can be fully replaced", async () => {
  const previous = process.env.SPAWN_BACKUP_KEEP; process.env.SPAWN_BACKUP_KEEP = "2";
  try {
    const j = new SessionJournal(root); seed(j, 2);
    for (let i = 0; i < 3; i++) { j.append("message.recorded", "pm", "pm", 1, { role: "user", content: `snapshot-${i}` }); await j.backup(); }
    const snapshots = await listBackups(root); assert.equal(snapshots.length, 2);
    const target = path.join(scratch, "replace-" + path.basename(root));
    await restoreBackup(root, target);
    fs.writeFileSync(path.join(target, ".spawn/events/retention.json"), "corrupt");
    fs.writeFileSync(path.join(target, ".spawn/events/retention.backup.json"), "corrupt");
    assert.throws(() => new SessionJournal(target), /Both retention baselines/);
    await restoreBackup(root, target, { replace: true });
    assert.equal(new SessionJournal(target).sequence().seq, snapshots[0]!.seq);
    assert.deepEqual(await new SessionJournal(target).search("pm", "snapshot-2"), await j.search("pm", "snapshot-2"));
  } finally { if (previous === undefined) delete process.env.SPAWN_BACKUP_KEEP; else process.env.SPAWN_BACKUP_KEEP = previous; }
});

test("same-size archive corruption cannot be published as a verified backup", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); seed(j); await j.maintain(policy);
  const prior = (await listBackups(root)).map((b) => b.id), dir = path.join(root, ".spawn/events/memory");
  const file = path.join(dir, fs.readdirSync(dir)[0]!), bytes = fs.readFileSync(file); bytes[Math.floor(bytes.length / 2)]! ^= 1; fs.writeFileSync(file, bytes);
  // Size-only startup checks deliberately stay cheap; backup must decode/check
  // logical archive integrity before advertising a usable recovery point.
  await assert.rejects(j.backup()); assert.deepEqual((await listBackups(root)).map((b) => b.id), prior);
  // The immutable object may have been uploaded, but no manifest references it.
  assert.equal((await verifyBackups(root)).every((b) => b.valid), true);
});

test("restore ownership excludes application startup throughout staging", async (t) => {
  const j = new SessionJournal(root); seed(j, 2); await j.backup();
  const target = path.join(scratch, "exclusive-" + path.basename(root)), rename = fs.promises.rename.bind(fs.promises); let checked = false;
  t.mock.method(fs.promises, "rename", async (from: fs.PathLike, to: fs.PathLike) => {
    if (!checked && String(from).includes("events.restore-")) {
      checked = true; assert.throws(() => registerRuntimeOwner(target), /Another application or restore/);
    }
    return rename(from, to);
  });
  await restoreBackup(root, target); assert.equal(checked, true);
  registerRuntimeOwner(target); // Available again after restore releases ownership.
});

test("TaskStatus pages many large handoffs without producing truncated JSON", async () => {
  const j = sessionJournal(); j.bind("pm", "Leader");
  for (let i = 0; i < 16; i++) {
    const id = `worker-${i}`; j.bind(id, "Worker", "pm", "goal ".repeat(500));
    j.append("runtime.event", "pm", id, 0, { type: "unit.handup", summary: "summary ".repeat(500), failed_acceptance: Array.from({ length: 20 }, () => "remaining ".repeat(100)), artifacts: [] });
    j.append("runtime.event", "pm", id, 0, { type: "agent.done", success: false, reason: "handoff" });
  }
  const { executeTool } = await import("../tools/registry.js");
  let offset: number | null = 0; const seen = new Set<string>();
  while (offset !== null) {
    const result = await executeTool("TaskStatus", { offset, limit: 20 }, { agentId: "pm" }); assert.equal(result.ok, true);
    const page = JSON.parse(result.output); assert.equal(page.total, 16); assert.ok(page.tasks.length);
    for (const task of page.tasks) { assert.equal(seen.has(task.id), false); seen.add(task.id); }
    offset = page.nextOffset;
  }
  assert.equal(seen.size, 16);
});

test("corrupt snapshot manifest is reported and fallback is explicit", async () => {
  const j = new SessionJournal(root); seed(j, 2); const first = await j.backup();
  j.append("message.recorded", "pm", "pm", 1, { role: "user", content: "latest" }); const latest = await j.backup();
  fs.writeFileSync(path.join(backupDirectory(root), "snapshots", latest.id + ".json"), "corrupt manifest");
  assert.equal((await verifyBackups(root))[0]!.valid, false);
  const result = await restoreBackup(root, path.join(scratch, "manifest-" + path.basename(root)));
  assert.ok("fallback" in result); assert.equal(result.fallback, true); assert.equal(result.id, first.id); assert.equal(result.latestAvailable, latest.id);
});
