import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionJournal, sessionJournal } from "../session/Journal.js";
import { directoryBytes } from "../session/Storage.js";

const original = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round4-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); });
afterEach(() => process.chdir(original));
after(() => {}); // Keep crash/cleanup evidence under the test TEMP directory.
const policy = { maxLogBytes: 0, retentionMs: 0, maxIndexBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
function seed(j: SessionJournal, count = 80) {
  j.bind("pm", "Leader");
  j.append("requirement.changed", "pm", "pm", 1, { text: "OLD_GOAL" });
  j.append("message.recorded", "pm", "pm", 1, { role: "user", content: "EARLY_MEMORY 保存最早的证据 " + "q".repeat(26000) + " TAIL_EVIDENCE" });
  for (let i = 0; i < count; i++) j.append("message.recorded", "pm", "pm", 1, { role: "assistant", content: `history-${i} ` + "routine ".repeat(20) });
  j.append("constraint.added", "pm", "pm", 1, { text: "所有数据保存在 E 盘" });
  j.append("requirement.changed", "pm", "pm", 2, { text: "CURRENT_TARGET" });
  j.append("runtime.event", "pm", "pm", 2, { type: "decision.record", decision: "保留 SSO 决策" });
  j.append("runtime.event", "pm", "pm", 2, { type: "todo.set", items: [{ id: "todo", text: "继续新目标", state: "todo" }] });
  j.bind("worker", "Worker", "pm", "new task");
  j.append("runtime.event", "pm", "worker", 2, { type: "tool.call", id: "unknown", name: "Write", args: { path: "inspect-first.txt", content: "unknown outcome" } });
  j.append("input.accepted", "pm", "pm", 2, { inputId: "pending", text: "继续" });
  j.append("inbox.received", "pm", "pm", 2, { id: "delivery", text: "pending delivery", channel: "feishu", metadata: {} });
  return j.current("pm")!;
}
async function until(check: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("verification timed out"); await new Promise((r) => setTimeout(r, 10)); }
}

test("quota compaction preserves current state, pending work and exact old memory across restart", async () => {
  const j = new SessionJournal(root, { segmentBytes: 4096 }); const before = seed(j);
  const existingReader = new SessionJournal(root); assert.deepEqual(existingReader.current("pm"), before);
  const report = await j.maintain(policy);
  assert.ok(report.compactedSegments > 0); assert.equal(report.logBytes, 0); assert.equal(report.overQuota, false);
  assert.deepEqual(report.errors, []);
  const restored = new SessionJournal(root, { verifyHistory: true });
  assert.deepEqual(restored.current("pm"), before);
  assert.deepEqual(existingReader.current("pm"), before);
  assert.equal(restored.binding("worker")!.goal, "new task"); assert.equal(restored.pending("pm")[0]!.id, "pending");
  assert.equal(restored.queued("feishu")[0]!.id, "delivery");
  assert.match((await restored.search("pm", "EARLY_MEMORY"))[0]!.excerpt, /保存最早/);
  assert.match((await restored.search("pm", "TAIL_EVIDENCE"))[0]!.excerpt, /TAIL_EVIDENCE/);
  restored.append("runtime.event", "pm", "pm", 2, { type: "decision.record", decision: "AFTER_RESTART" });
  assert.match(new SessionJournal(root).current("pm")!.decisions.at(-1)!.text, /AFTER_RESTART/);
});

test("retention age compacts expired logs even with ample byte quota; fresh logs remain", async () => {
  const j = new SessionJournal(root, { segmentBytes: 1024 }); seed(j, 10);
  const fresh = await j.maintain({ ...policy, maxLogBytes: 1024 * 1024, retentionMs: 86400000 });
  assert.equal(fresh.compactedSegments, 0);
  const expired = await j.maintain({ ...policy, maxLogBytes: 1024 * 1024, retentionMs: 1000 }, Date.now() + 10000);
  assert.ok(expired.compactedSegments > 0); assert.equal(new SessionJournal(root).current("pm")!.goal, "CURRENT_TARGET");
});

test("independent baseline copy survives corruption; two invalid copies fail closed", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); const before = seed(j, 5); await j.maintain(policy);
  const dir = path.join(root, ".spawn/events");
  fs.writeFileSync(path.join(dir, "retention.json"), "broken");
  assert.deepEqual(new SessionJournal(root).current("pm"), before);
  fs.writeFileSync(path.join(dir, "retention.backup.json"), "also broken");
  assert.throws(() => new SessionJournal(root), /Both retention baselines/);
});

test("quota pressure never deletes protected memory or silently changes the target", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048, policy: { maxIndexBytes: 0, maxTotalBytes: 1 } }); const before = seed(j, 5);
  const report = await j.maintain({ ...policy, maxTotalBytes: 1, maxIndexBytes: 0 });
  assert.equal(report.overQuota, true); assert.equal(report.indexBytes, 0);
  assert.deepEqual(new SessionJournal(root).current("pm"), before);
  assert.match((await j.search("pm", "EARLY_MEMORY"))[0]!.excerpt, /EARLY_MEMORY/);
});

test("failed physical deletion is reported as quota pressure and retry completes safely", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); const before = seed(j, 5);
  const unlink = fs.promises.unlink.bind(fs.promises); let failed = false;
  fs.promises.unlink = async (file) => {
    if (!failed && String(file).endsWith(".jsonl")) { failed = true; throw Object.assign(new Error("simulated locked log"), { code: "EPERM" }); }
    return unlink(file);
  };
  try {
    const report = await j.maintain(policy);
    assert.equal(report.overQuota, true); assert.ok(report.logBytes > 0); assert.equal(report.errors.length, 1);
    assert.deepEqual(new SessionJournal(root).current("pm"), before);
  } finally { fs.promises.unlink = unlink; }
  const retry = await j.maintain(policy);
  assert.equal(retry.overQuota, false); assert.equal(retry.logBytes, 0); assert.deepEqual(retry.errors, []);
});

test("warm index skips unrelated history and matches full scan for substrings, CJK and short terms", async () => {
  const j = new SessionJournal(root, { segmentBytes: 4096 }); j.bind("pm", "Leader"); j.bind("other", "Leader");
  for (let i = 0; i < 200; i++) j.append("message.recorded", i % 2 ? "pm" : "other", i % 2 ? "pm" : "other", 0, { role: "user", content: i === 19 ? "unique_needle 北京天气 emoji 😀 你好" : `routine event-${i} zebra plain message` });
  await j.maintain({ ...policy, maxLogBytes: 1024 * 1024, retentionMs: 86400000 });
  for (const query of ["unique_needle", "北京天气", "京天", "你好", "😀", "needle 北京", "zebra"]) {
    const indexed = await j.search("pm", query), stats = { ...j.lastSearch };
    const scanned = await j.search("pm", query, 10, { useIndex: false });
    assert.deepEqual(indexed, scanned, query);
    if (query === "unique_needle") { assert.ok(stats.indexHits > 0); assert.ok(stats.bytesRead < j.lastSearch.bytesRead); }
  }
  assert.equal((await j.search("other", "unique_needle")).length, 0);
});

test("missing or corrupted indexes rebuild from retained memory; cache stays within quota", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048, policy: { maxIndexBytes: 4096 } }); seed(j, 20);
  await j.maintain({ ...policy, maxIndexBytes: 4096 });
  const directory = path.join(root, ".spawn/events/index");
  for (const name of fs.readdirSync(directory)) fs.writeFileSync(path.join(directory, name), "corrupt index");
  assert.match((await j.search("pm", "EARLY_MEMORY"))[0]!.excerpt, /EARLY_MEMORY/);
  assert.ok(j.lastSearch.rebuilt > 0 || (j.lastSearch.fallbackSources ?? 0) > 0); await (await import("../session/SearchIndex.js")).waitForIndexing(); assert.ok(await directoryBytes(directory) <= 4096);
});

test("cleanup only removes archived terminal process records, preserving active and blocked evidence", async () => {
  const j = new SessionJournal(root); seed(j, 1);
  const terminal = randomUUID(), blocked = randomUUID(), running = randomUUID();
  for (const [token, status, archived] of [[terminal, "completed", true], [blocked, "blocked", true], [running, "running", false]] as const) {
    const dir = path.join(root, ".spawn/processes", archived ? "completed" : "", token); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ token, status, updatedAt: Date.now() - 100000 }));
    fs.writeFileSync(path.join(dir, "intent.json"), "test evidence");
  }
  const report = await j.maintain({ ...policy, processRetentionMs: 1, maxCompletedProcessBytes: 0 });
  assert.equal(report.completedProcesses, 1); assert.equal(fs.existsSync(path.join(root, ".spawn/processes/completed", terminal)), false);
  assert.equal(fs.existsSync(path.join(root, ".spawn/processes/completed", blocked, "record.json")), true);
  assert.equal(fs.existsSync(path.join(root, ".spawn/processes", running, "record.json")), true);
});

test("abandoned atomic drafts are cleaned without deleting unknown files or committed memory", async () => {
  const j = new SessionJournal(root); const before = seed(j, 1);
  const directory = path.join(root, ".spawn/events"), draft = path.join(directory, `checkpoint.json.${randomUUID()}.tmp`);
  const torn = path.join(directory, `journal.jsonl.torn-${randomUUID()}`), unknown = path.join(directory, "user-notes.tmp");
  for (const file of [draft, torn, unknown]) fs.writeFileSync(file, "uncommitted");
  await j.maintain(policy, Date.now() + 2 * 86400000);
  assert.equal(fs.existsSync(draft), false); assert.equal(fs.existsSync(torn), false); assert.equal(fs.existsSync(unknown), true);
  assert.deepEqual(new SessionJournal(root).current("pm"), before);
});

for (const phase of ["archive", "primary", "delete"] as const) test(`abrupt exit after ${phase} publication resumes without losing the current target`, async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048 }); const before = seed(j, 8);
  const module = new URL("../session/Journal.ts", import.meta.url).href;
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href;
  const script = `import fs from 'node:fs';import {SessionJournal} from ${JSON.stringify(module)};
    const phase=${JSON.stringify(phase)};
    const rename=fs.promises.rename.bind(fs.promises);fs.promises.rename=async(a,b)=>{await rename(a,b);if(phase==='archive'&&String(b).endsWith('.mem.gz'))process.exit(23);};
    const sync=fs.renameSync.bind(fs);fs.renameSync=(a,b)=>{sync(a,b);if(phase==='primary'&&String(b).endsWith('retention.json'))process.exit(23);};
    const unlink=fs.promises.unlink.bind(fs.promises);fs.promises.unlink=async(f)=>{await unlink(f);if(phase==='delete'&&String(f).endsWith('.jsonl'))process.exit(23);};
    await new SessionJournal(process.cwd()).maintain(${JSON.stringify(policy)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", loader, "--input-type=module", "-e", script], { cwd: root }), (e: any) => e.code === 23);
  const recovered = new SessionJournal(root); assert.deepEqual(recovered.current("pm"), before);
  await recovered.maintain(policy);
  assert.match((await new SessionJournal(root).search("pm", "TAIL_EVIDENCE"))[0]!.excerpt, /TAIL_EVIDENCE/);
});

test("PM answers while archive I/O is paused; new input survives the later compaction commit", async () => {
  const j = sessionJournal(); seed(j, 5);
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ type: "message", to: "user", text: "PM_DURING_MAINTENANCE" }) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local", baseUrl: `http://127.0.0.1:${(server.address() as any).port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
  const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
  const { ensureAgent, _resetForTest } = await import("../store.js"); _resetForTest();
  const r = createRuntimeContext(), replies: string[] = [];
  configureAgentHandlers({ ...r, MODEL: "mock", DEMO: false, buildSystemPrompt: () => "PM", killAgent: (id) => r.agents.get(id)?.kill() });
  const rename = fs.promises.rename.bind(fs.promises); let paused = false, release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fs.promises.rename = async (a, b) => { await rename(a, b); if (String(b).endsWith(".mem.gz") && !paused) { paused = true; await gate; } };
  let work: Promise<unknown> | undefined;
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", resumedMemoryId: "pm", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => replies.length >= 1);
    work = j.maintain(policy); await until(() => paused);
    const count = replies.length; r.agents.get("pm")!.receiveUserInput("progress?");
    await until(() => replies.length > count);
    r.agents.get("pm")!.receiveUserInput("/revise AFTER_MAINTENANCE_CHANGE");
    await until(() => replies.length > count + 1);
    release(); await work;
    assert.equal(new SessionJournal(root).current("pm")!.goal, "AFTER_MAINTENANCE_CHANGE");
    assert.equal(new SessionJournal(root).current("pm")!.revision, 3);
    assert.ok((await j.search("pm", "progress?")).length > 0);
  } finally {
    release(); if (work) await work.catch(() => {}); fs.promises.rename = rename;
    for (const a of r.agents.values()) a.kill(); for (const s of r.secretaries.values()) s.destroy(); r.pm.destroy();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("automatic maintenance after rotation enforces configured quotas without changing pending state", async () => {
  const j = new SessionJournal(root, { segmentBytes: 2048, automatic: true, policy }); const before = seed(j, 2);
  await until(() => !!j.lastMaintenance, 10000);
  assert.equal(j.lastMaintenance!.logBytes, 0); assert.equal(j.lastMaintenance!.overQuota, false);
  assert.deepEqual(new SessionJournal(root).current("pm"), before);
  assert.match((await j.search("pm", "EARLY_MEMORY"))[0]!.excerpt, /EARLY_MEMORY/);
});
