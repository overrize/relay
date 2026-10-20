import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { SessionJournal } from "../dist/session/Journal.js";

// Run after npm run build. Fixtures stay under the repository, not the system
// TEMP drive. Compare identical histories with and without checkpoint replay.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const count = Number(process.argv.find((a) => a.startsWith("--events="))?.split("=")[1] ?? 4000);
if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw new Error("--events must be an integer between 1 and 100000");
const parent = process.env.SPAWN_BENCHMARK_DIR ?? path.join(repo, ".test-tmp");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "session-benchmark-"));
const writer = new SessionJournal(root); writer.bind("pm", "Leader");
for (let i = 0; i < count; i++) {
  writer.append("benchmark", "pm", "pm", 0, { content: "x".repeat(4096) });
  if (i && i % 1000 === 0) console.log(`seeded ${i}/${count}`);
}
const start = performance.now(), fast = new SessionJournal(root), fastMs = performance.now() - start;
const fullStart = performance.now(), full = new SessionJournal(root, { verifyHistory: true }), fullMs = performance.now() - fullStart;
assert.deepEqual(fast.current("pm"), full.current("pm"));
const report = { root, events: count + 1, fastMs, fullMs, fast: fast.stats, full: full.stats, note: "Local filesystem cache is warm; timings are not a cold-disk SLA." };
fs.writeFileSync(path.join(root, "benchmark.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
