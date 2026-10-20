import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import http from "node:http";
import { SessionJournal } from "../session/Journal.js";
import { recoverOrphanCommands } from "../tools/processRecovery.js";
import { cancelAllAgentTools, execCommand } from "../tools/command.js";

const original = process.cwd(), scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-round3-"));
process.env.SPAWN_CONFIG_DIR = path.join(scratch, "config");
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(scratch, "case-")); process.chdir(root); });
afterEach(() => process.chdir(original));
after(async () => { await cancelAllAgentTools(); });
async function until(check: () => boolean, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("process verification timed out"); await new Promise((r) => setTimeout(r, 25)); }
}
function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function segments() { return fs.readdirSync(path.join(root, ".spawn/events/segments")).sort(); }

test("segmented checkpoint restores with bounded tail replay; recall spans every segment", async () => {
  const j = new SessionJournal(root, { segmentBytes: 48 * 1024 }); j.bind("pm", "Leader");
  for (let i = 0; i < 500; i++) j.append("message.recorded", "pm", "pm", 0, { role: "user", content: `FACT_${i}_END ` + "history ".repeat(260) });
  j.append("requirement.changed", "pm", "pm", 1, { text: "CURRENT_GOAL" });
  const fullBytes = segments().reduce((n, name) => n + fs.statSync(path.join(root, ".spawn/events/segments", name)).size, 0) + fs.statSync(j.file).size;
  const start = performance.now(), restored = new SessionJournal(root);
  const elapsed = performance.now() - start;
  assert.equal(restored.stats.checkpointUsed, true);
  assert.ok(restored.stats.replayedEvents < 30);
  assert.ok(restored.stats.bytesRead < fullBytes / 5);
  assert.equal(restored.current("pm")!.goal, "CURRENT_GOAL");
  const full = new SessionJournal(root, { verifyHistory: true });
  assert.equal(full.stats.checkpointUsed, false); assert.equal(full.stats.replayedEvents, 502);
  assert.deepEqual(full.current("pm"), restored.current("pm"));
  assert.match((await restored.search("pm", "FACT_0_END"))[0]!.excerpt, /FACT_0_END/);
  assert.match((await restored.search("pm", "FACT_499_END"))[0]!.excerpt, /FACT_499_END/);
  console.log(`round3 recovery: ${fullBytes} bytes, read=${restored.stats.bytesRead}, replay=${restored.stats.replayedEvents}, ms=${elapsed.toFixed(1)}`);
});

test("invalid checkpoint falls back to verified history; modified sealed records fail closed", () => {
  const j = new SessionJournal(root, { segmentBytes: 1500 }); j.bind("pm", "Leader");
  for (let i = 0; i < 15; i++) j.append("message.recorded", "pm", "pm", 0, { role: "user", content: "original".repeat(100) });
  fs.writeFileSync(path.join(root, ".spawn/events/checkpoint.json"), '{"broken":');
  const restored = new SessionJournal(root);
  assert.equal(restored.stats.checkpointUsed, false); assert.equal(restored.stats.replayedEvents, 16);
  const file = path.join(root, ".spawn/events/segments", segments()[0]!);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"Leader"', '"Worker"'));
  assert.throws(() => new SessionJournal(root), /integrity/);
});

test("recovery tolerates a crash between segment rename and checkpoint publication", () => {
  const j = new SessionJournal(root); j.bind("pm", "Leader");
  j.append("requirement.changed", "pm", "pm", 1, { text: "AFTER_ROTATION_CRASH" });
  const dir = path.join(root, ".spawn/events/segments"); fs.mkdirSync(dir);
  fs.renameSync(j.file, path.join(dir, "0000000000000001-0000000000000002.jsonl"));
  const recovered = new SessionJournal(root);
  assert.equal(recovered.current("pm")!.goal, "AFTER_ROTATION_CRASH");
  recovered.append("constraint.added", "pm", "pm", 1, { text: "E drive" });
  assert.deepEqual(new SessionJournal(root).current("pm")!.constraints, ["E drive"]);
});

test("multiple readers observe incremental appends and rotations without duplicate history", () => {
  const writer = new SessionJournal(root, { segmentBytes: 2000 }); writer.bind("pm", "Leader");
  const reader = new SessionJournal(root);
  for (let i = 0; i < 25; i++) {
    writer.append("message.recorded", "pm", "pm", 0, { role: "user", content: String(i) });
    assert.equal(reader.history("pm").length, i + 1);
  }
  assert.equal(new Set(reader.history("pm").map((m) => m.content)).size, 25);
  const before = reader.stats.replayedEvents; reader.current("pm"); assert.equal(reader.stats.replayedEvents, before);
});

test("missing sealed segments fail closed", () => {
  const j = new SessionJournal(root, { segmentBytes: 1 }); j.bind("pm", "Leader");
  j.append("requirement.changed", "pm", "pm", 1, { text: "target" });
  const first = path.join(root, ".spawn/events/segments", segments()[0]!);
  fs.renameSync(first, `${first}.missing`);
  assert.throws(() => new SessionJournal(root), /gap/);
});

test("removing every sealed segment cannot silently reset a checkpointed session", () => {
  const j = new SessionJournal(root, { segmentBytes: 1 }); j.bind("pm", "Leader");
  const dir = path.join(root, ".spawn/events/segments"); fs.renameSync(dir, `${dir}.missing`);
  assert.throws(() => new SessionJournal(root), /missing sealed/);
});

async function crashFixture() {
  const marker = path.join(root, "should-not-appear"), ready = path.join(root, "ready.json");
  const worker = path.join(root, "worker.cjs");
  fs.writeFileSync(worker, `require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'stale'),2500);`);
  const ownerFile = path.join(root, "owner.mjs"), moduleUrl = new URL("../tools/command.ts", import.meta.url).href;
  fs.writeFileSync(ownerFile, `import {execCommand} from ${JSON.stringify(moduleUrl)}; await execCommand(${JSON.stringify(`"${process.execPath}" "${worker}"`)},{timeout:30000});`);
  const loader = new URL("../../node_modules/tsx/dist/esm/index.mjs", import.meta.url).href;
  const owner = spawn(process.execPath, ["--import", loader, ownerFile], { cwd: root, stdio: "ignore", windowsHide: true });
  await until(() => fs.existsSync(ready));
  const pid = JSON.parse(fs.readFileSync(ready, "utf8")).pid as number;
  const token = fs.readdirSync(path.join(root, ".spawn/processes"))[0]!;
  return { owner, pid, token, marker, record: path.join(root, ".spawn/processes", token, "record.json") };
}
async function killOwner(owner: ChildProcess) {
  owner.kill("SIGKILL"); await new Promise<void>((resolve) => owner.once("exit", () => resolve()));
}

test("hard-killed application leaves a supervised tree that restart cleanup safely terminates", async () => {
  const f = await crashFixture();
  try {
    assert.equal(processAlive(f.pid), true); await killOwner(f.owner);
    await recoverOrphanCommands(root);
    await until(() => !processAlive(f.pid));
    const recoveredRecord = fs.existsSync(f.record) ? f.record : path.join(root, ".spawn/processes/completed", f.token, "record.json");
    assert.equal(JSON.parse(fs.readFileSync(recoveredRecord, "utf8")).status, "cancelled");
    await new Promise((r) => setTimeout(r, 2600)); assert.equal(fs.existsSync(f.marker), false);
  } finally { if (f.owner.exitCode === null && !f.owner.killed) f.owner.kill(); }
});

test("watchdog cleans the tree even if the application never restarts", async () => {
  const f = await crashFixture(); await killOwner(f.owner);
  await until(() => !processAlive(f.pid));
  await until(() => JSON.parse(fs.readFileSync(f.record, "utf8")).status === "cancelled");
  assert.equal(JSON.parse(fs.readFileSync(f.record, "utf8")).reason, "owner-lost");
});

test("killing the supervisor as well leaves an explicit blocker instead of a guessed PID kill", async () => {
  const f = await crashFixture();
  const record = JSON.parse(fs.readFileSync(f.record, "utf8"));
  const ownerExit = new Promise<void>((resolve) => f.owner.once("exit", () => resolve()));
  try {
    process.kill(record.pid, "SIGKILL");
    await ownerExit;
    await assert.rejects(recoverOrphanCommands(root), /inspection|unconfirmed/);
    assert.equal(processAlive(f.pid), true, "unconfirmed identity must not cause a guessed kill");
  } finally {
    // These PIDs came from this test's live fixture and have never been resumed.
    if (processAlive(f.pid)) process.kill(f.pid, "SIGKILL");
    await until(() => !processAlive(f.pid));
    if (processAlive(record.childPid)) process.kill(record.childPid, "SIGKILL");
  }
});

test("saved PIDs are never used as kill targets; unconfirmed cleanup blocks safely", async () => {
  const token = randomUUID(), dir = path.join(root, ".spawn/processes", token); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.json"), JSON.stringify({ version: 1, token, ownerPid: 2147483000, createdAt: Date.now() }));
  fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ token, pid: process.pid, childPid: process.pid, status: "running" }));
  await assert.rejects(recoverOrphanCommands(root, 250), /timed out/);
  assert.equal(processAlive(process.pid), true); assert.equal(fs.existsSync(path.join(dir, "cancel")), true);
});

test("an incomplete registry entry cannot be mistaken for a completed process", async () => {
  fs.mkdirSync(path.join(root, ".spawn/processes", randomUUID()), { recursive: true });
  await assert.rejects(recoverOrphanCommands(root), /Incomplete process registry/);
});

test("cancel capability persisted before delayed supervisor startup prevents execution", async () => {
  const token = randomUUID(), dir = path.join(root, ".spawn/processes", token); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.json"), JSON.stringify({ version: 1, token, ownerPid: 2147483000, createdAt: Date.now() }));
  assert.equal((await recoverOrphanCommands(root))[0]!.status, "abandoned");
  assert.equal(fs.existsSync(path.join(dir, "cancel")), true);
});

test("supervised commands preserve stdout and exit failures", async () => {
  assert.match((await execCommand('echo supervisor-output')).toString(), /supervisor-output/);
  await assert.rejects(execCommand(`"${process.execPath}" -e "process.exit(7)"`), (e: any) => e.code === 7);
});

test("unconfirmed orphan cleanup blocks new tools while PM can still answer progress questions", async () => {
  const token = randomUUID(), dir = path.join(root, ".spawn/processes", token); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "intent.json"), JSON.stringify({ version: 1, token, ownerPid: 2147483000, createdAt: Date.now() }));
  fs.writeFileSync(path.join(dir, "record.json"), JSON.stringify({ token, status: "blocked", pid: process.pid }));
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ type: "message", to: "user", text: "PM_STILL_AVAILABLE" }) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!, "config.json"), JSON.stringify({ models: { mock: { provider: "openai", model: "mock", apiKey: "local", baseUrl: `http://127.0.0.1:${(server.address() as any).port}` } }, agents: { leader: { model: "mock" }, worker: { model: "mock" }, secretary: { model: "mock" } } }));
  const { createRuntimeContext } = await import("../runtime/RuntimeContext.js");
  const { configureAgentHandlers, startLeaderAgent } = await import("../runtime/AgentHandlers.js");
  const { executeTool } = await import("../tools/registry.js");
  const { ensureAgent, _resetForTest } = await import("../store.js");
  _resetForTest(); const r = createRuntimeContext(), replies: string[] = [];
  configureAgentHandlers({ ...r, MODEL: "mock", DEMO: false, buildSystemPrompt: () => "PM", killAgent: (id) => r.agents.get(id)?.kill() });
  try {
    ensureAgent({ id: "pm", name: "PM", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: "current goal", conversationMode: true, replyHook: (t) => replies.push(t) });
    await until(() => replies.length === 1);
    r.agents.get("pm")!.receiveUserInput("progress?");
    await until(() => replies.length === 2);
    const tool = await executeTool("Write", { path: "must-not-write.txt", content: "unsafe" }, { agentId: "pm" });
    assert.equal(tool.code, "recovery_blocked"); assert.equal(fs.existsSync("must-not-write.txt"), false);
    assert.deepEqual(replies, ["PM_STILL_AVAILABLE", "PM_STILL_AVAILABLE"]);
  } finally {
    for (const a of r.agents.values()) a.kill(); for (const s of r.secretaries.values()) s.destroy(); r.pm.destroy();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
