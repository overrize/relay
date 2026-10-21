/**
 * TerminalRestore — terminal mode restore on exit.
 *
 * The TUI enables mouse tracking at runtime (wheel scrolling) and bracketed
 * paste. Both are terminal-global modes: if the process dies without turning
 * them off, the *parent shell* keeps receiving the reports. Symptom: every
 * wheel scroll dumps SGR sequences (`\x1b[<64;41;19M`) into the shell prompt.
 *
 * Why this needs a synchronous write
 * ----------------------------------
 * Node's process.stdout is asynchronous for TTYs **on Windows** (synchronous on
 * POSIX — see "A note on process I/O" in the Node docs). So a
 * `process.stdout.write()` issued from a `process.on("exit")` handler, or on the
 * line before `process.exit()`, is discarded before it reaches the terminal.
 * The restore silently did nothing on Windows while working fine on Linux/macOS.
 *
 * `fs.writeSync(1, ...)` bypasses the async stream and always flushes. It also
 * bypasses the stdout write shim in AgentRuntime, which is what we want:
 * control sequences must never be wrapped in synchronized-output markers.
 */
import * as fs from "node:fs";

/** Turn off X10 (1000), btn-event (1002), any-event (1003) and SGR (1006) mouse reporting. */
export const DISABLE_MOUSE_TRACKING = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

/** Full restore: mouse off + bracketed paste off (2004) + cursor visible (25h). */
export const TERM_RESET = `${DISABLE_MOUSE_TRACKING}\x1b[?2004l\x1b[0 q\x1b[?25h`;

/** Injectable sink so tests can assert what would be written to fd 1. */
export type SyncWriter = (seq: string) => void;

const defaultWriter: SyncWriter = (seq) => {
  try {
    fs.writeSync(1, seq);
  } catch {
    /* fd closed / EPERM (Windows AV holds handles) — nothing left to restore */
  }
};

let _writer: SyncWriter = defaultWriter;

/** Tests only — swap the sync writer. Pass null to restore the real one. */
export function setSyncWriterForTests(w: SyncWriter | null): void {
  _writer = w ?? defaultWriter;
}

/**
 * Write a terminal control sequence synchronously.
 * Safe to call from a `process.on("exit")` handler.
 */
export function writeTermSync(seq: string): void {
  _writer(seq);
}

/**
 * The sequence written on process exit: restore modes, then park the cursor on
 * the last row and clear that line so the shell prompt starts clean.
 */
export function buildExitRestoreSequence(rows: number): string {
  return `${TERM_RESET}\x1b[${rows};1H\x1b[2K\n`;
}
