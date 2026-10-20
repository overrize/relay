import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionJournal } from "../dist/session/Journal.js";
import { waitForIndexing } from "../dist/session/SearchIndex.js";
import { directoryBytes } from "../dist/session/Storage.js";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
if (process.argv.includes("--probe")) {
  const journal = new SessionJournal(arg("root")), start = performance.now();
  const hits = await journal.search("pm", "needle_important_01337");
  console.log(JSON.stringify({ hits, ms: performance.now() - start, stats: journal.lastSearch }));
  await waitForIndexing();
  process.exit(0);
}
const count = Number(arg("events") ?? 2000);
if (!Number.isSafeInteger(count) || count < 2 || count > 100000) throw new Error("--events must be between 2 and 100000");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parent = process.env.SPAWN_BENCHMARK_DIR ?? path.join(repo, ".test-tmp");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "history-benchmark-"));
const segmentBytes = Number(arg("segment-bytes") ?? 32768);
if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1024) throw new Error("--segment-bytes must be at least 1024");
const journal = new SessionJournal(root, { segmentBytes }); journal.bind("pm", "Leader");
for (let i = 0; i < count; i++) {
  journal.append("message.recorded", "pm", "pm", 0, { role: "user", content: (i === 1 ? "needle_important_01337 北京需求 " : "") + `entry-${i} coding evidence with stable session constraints ` + "plain text ".repeat(15) });
  if (i && i % 1000 === 0) console.log(`seeded ${i}/${count}`);
}
const coldStart = performance.now(); await journal.search("pm", "needle_important_01337");
const missingIndex = { ms: performance.now() - coldStart, stats: { ...journal.lastSearch } }; await waitForIndexing();
const policy = { maxLogBytes: 0, retentionMs: 0, maxIndexBytes: 32 * 1024 * 1024 };
await journal.maintain(policy);
const segments = fs.readdirSync(path.join(root, ".spawn/events/memory")).length;
for (let i = 1; i < Math.ceil(segments / 64); i++) await journal.maintain(policy);
const probe = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), "--probe", `--root=${root}`], { maxBuffer: 1024 * 1024 });
const processCold = JSON.parse(probe.stdout);
const start = performance.now(), indexed = await journal.search("pm", "needle_important_01337"), indexedMs = performance.now() - start;
const indexStats = { ...journal.lastSearch };
const fullStart = performance.now(), scanned = await journal.search("pm", "needle_important_01337", 10, { useIndex: false }), scanMs = performance.now() - fullStart;
assert.deepEqual(indexed, scanned); assert.equal(indexed.length, 1);
assert.deepEqual(processCold.hits, scanned);
const report = { root, events: count + 1, segments, missingIndex, processCold: { ms: processCold.ms, stats: processCold.stats }, indexedMs, scanMs, indexed: indexStats, scan: journal.lastSearch, storageBytes: await directoryBytes(path.join(root, ".spawn/events")), note: "Fresh Node process tests persistent catalog; filesystem cache is warm. Missing-index query scans raw logs. No cold-disk latency SLA." };
fs.writeFileSync(path.join(root, "search-benchmark.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
