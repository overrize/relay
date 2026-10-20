/**
 * ObservabilityRuntime — the single façade for spawn's observability side-channel
 * (spawn-1.0 M1-6a). god-file code records metrics / writes diagnostic logs / installs
 * the stderr→tui.log sink ONLY through here. Behaviour-neutral: this owns *where* the
 * bytes go, never *what* they say.
 */

import fs from "node:fs";

// Metric surface — re-exported unwrapped so identity holds (see 6a test §3).
export {
  formatMetricsReport,
  getHealthMetricsStore,
  recordHealthMetric,
  setHealthMetricsStoreForTests,
  HealthMetricsStore,
} from "./HealthMetrics.js";
export type { HealthMetric, HealthMetricInput } from "./HealthMetrics.js";

// ── A. Diagnostic log seam ──────────────────────────────────────────────────
// The god-file emits ~55 raw `[id] …\n` lines. They all funnel through logDiag so
// tests can capture them and future runtime modules never touch process.stderr.

type DiagSink = (line: string) => void;

const defaultSink: DiagSink = (line) => {
  process.stderr.write(line);
};

let diagSink: DiagSink | null = null;

/** The active sink (test override if set, else the process.stderr writer). */
export function getDiagSink(): DiagSink {
  return diagSink ?? defaultSink;
}

/** Write a diagnostic line verbatim — no prefix/newline injection. */
export function logDiag(line: string): void {
  getDiagSink()(line);
}

/** Override the sink in tests; pass null to restore the default. */
export function setDiagSinkForTests(sink: DiagSink | null): void {
  diagSink = sink;
}

// ── C. Diagnostic channel install ───────────────────────────────────────────
// While the interactive TUI runs, raw stderr corrupts Ink's <Static> line
// tracking. Redirect stderr to tui.log (append). Skipped for non-TTY (tests/CI)
// and demo mode. Extracted verbatim from the old inline block.
export function installDiagnosticSink(opts: {
  isTTY: boolean;
  demo: boolean;
  logFile: string;
}): (() => Promise<void>) | undefined {
  if (!opts.isTTY || opts.demo) return;
  try {
    const previous = process.stderr.write;
    const stream = fs.createWriteStream(opts.logFile, { flags: "a" });
    process.stderr.write = ((chunk: any, ...rest: any[]) =>
      stream.write(chunk, ...rest)) as typeof process.stderr.write;
    return () => new Promise<void>((resolve) => {
      process.stderr.write = previous;
      stream.end(() => { stream.close(() => resolve()); });
    });
  } catch {
    /* fall back to terminal stderr */
  }
}
