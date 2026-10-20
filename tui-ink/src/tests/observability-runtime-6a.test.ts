/**
 * M1-6a · ObservabilityRuntime façade contract.
 * Asserts the guarantees in docs/spawn-1.0/M1-6a-SPEC.md §4.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  logDiag,
  getDiagSink,
  setDiagSinkForTests,
  installDiagnosticSink,
  recordHealthMetric,
  getHealthMetricsStore,
  setHealthMetricsStoreForTests,
  HealthMetricsStore,
} from "../runtime/ObservabilityRuntime.js";
import * as HealthMetrics from "../runtime/HealthMetrics.js";

afterEach(() => {
  setDiagSinkForTests(null);
  setHealthMetricsStoreForTests(null);
});

describe("M1-6a ObservabilityRuntime façade", () => {
  it("§4.1 logDiag routes to the sink verbatim (no prefix/newline injection)", () => {
    const captured: string[] = [];
    setDiagSinkForTests((s) => captured.push(s));
    logDiag("[x] hi\n");
    logDiag("no-newline");
    assert.deepEqual(captured, ["[x] hi\n", "no-newline"]);
  });

  it("§4.2 sink resets to a process.stderr writer", () => {
    setDiagSinkForTests(null);
    const orig = process.stderr.write.bind(process.stderr);

    const seen: string[] = [];
    (process.stderr as any).write = (chunk: any) => {
      seen.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      getDiagSink()("via-default\n");
    } finally {
      (process.stderr as any).write = orig;
    }
    assert.ok(seen.includes("via-default\n"));
  });

  it("§4.3 metric API is re-exported unwrapped (identity holds)", () => {
    assert.equal(recordHealthMetric, HealthMetrics.recordHealthMetric);
    assert.equal(getHealthMetricsStore, HealthMetrics.getHealthMetricsStore);
    const a = getHealthMetricsStore();
    const b = getHealthMetricsStore();
    assert.equal(a, b, "getHealthMetricsStore returns a singleton");
  });

  it("§4.4 the four guarded event types record and read back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-6a-"));
    setHealthMetricsStoreForTests(new HealthMetricsStore(dir));
    const cases: Array<[string, string]> = [
      ["resume_context_missing", "warn"],
      ["hard_circuit_fired", "critical"],
      ["test_failed_but_claimed_done", "critical"],
      ["agent_done_blocked_by_guard", "warn"],
    ];
    for (const [event_type, severity] of cases) {
      recordHealthMetric({ agent_id: "a1", event_type: event_type as any, severity: severity as any, reason: "t" });
    }
    const read = getHealthMetricsStore().readMetrics();
    assert.equal(read.length, 4);
    for (const [event_type, severity] of cases) {
      const m = read.find((r) => r.event_type === event_type);
      assert.ok(m, `${event_type} recorded`);
      assert.equal(m!.severity, severity, `${event_type} severity`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("§4.5 installDiagnosticSink honours the isTTY/demo gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-6a-sink-"));
    const logFile = path.join(dir, "tui.log");

    // non-TTY → no override
    let before = process.stderr.write;
    installDiagnosticSink({ isTTY: false, demo: false, logFile });
    assert.equal(process.stderr.write, before, "non-TTY skips");

    // demo → no override
    before = process.stderr.write;
    installDiagnosticSink({ isTTY: true, demo: true, logFile });
    assert.equal(process.stderr.write, before, "demo skips");

    // TTY && !demo → redirects to logFile
    const orig = process.stderr.write.bind(process.stderr);
    let cleanup: (() => Promise<void>) | undefined;
    try {
      cleanup = installDiagnosticSink({ isTTY: true, demo: false, logFile });
      process.stderr.write("z\n");
    } finally {
      await cleanup?.();
      (process.stderr as any).write = orig;
    }
    // createWriteStream flushes asynchronously — poll briefly for the file.
    let contents = "";
    for (let i = 0; i < 50 && !/z\n/.test(contents); i++) {
      try { contents = fs.readFileSync(logFile, "utf8"); } catch { /* not yet */ }
      if (!/z\n/.test(contents)) await new Promise((r) => setTimeout(r, 10));
    }
    assert.match(contents, /z\n/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
