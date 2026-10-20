import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeSnapshot } from "../memory/atomic.js";
import { SUPERVISOR_SOURCE } from "./supervisor.js";
import { requestProcessCancel, archiveFinishedProcess } from "./processRecovery.js";

export const toolSignal = new AsyncLocalStorage<AbortSignal>();
const toolOwner = new AsyncLocalStorage<string | undefined>();
const running = new Map<string, Set<AbortController>>();
const completions = new Set<Promise<void>>();
const byAgent = new Map<string, Set<Promise<void>>>();

export function cancelAgentTools(agentId: string): void {
  for (const controller of running.get(agentId) ?? []) controller.abort();
}
export async function cancelAgentToolsAndWait(agentId: string): Promise<void> {
  cancelAgentTools(agentId);
  await Promise.allSettled([...(byAgent.get(agentId) ?? [])]);
}

export async function cancelAllAgentTools(): Promise<void> {
  for (const group of running.values()) for (const controller of group) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...completions]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2500); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function withToolCancellation<T>(agentId: string | undefined, run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const key = agentId ?? "anonymous";
  const group = running.get(key) ?? new Set<AbortController>();
  group.add(controller);
  running.set(key, group);
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  completions.add(completion);
  const waits = byAgent.get(key) ?? new Set<Promise<void>>();
  waits.add(completion); byAgent.set(key, waits);
  try { return await toolOwner.run(agentId, () => toolSignal.run(controller.signal, run)); }
  finally {
    group.delete(controller); if (!group.size) running.delete(key);
    completions.delete(completion); complete();
    waits.delete(completion); if (!waits.size) byAgent.delete(key);
  }
}

/** Non-blocking, bounded-output shell execution, including process-tree cancel. */
export function execCommand(command: string, options: {
  cwd?: string; timeout?: number; encoding?: string; shell?: unknown;
  /** Internal structured process invocation; never constructed from model shell text. */
  invocation?: { file: string; args: string[]; input?: string };
  env?: NodeJS.ProcessEnv; stdoutOnly?: boolean;
} = {}): Promise<Buffer> {
  const signal = toolSignal.getStore();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Object.assign(new Error("Tool cancelled"), { code: "ABORT_ERR" })); return; }
    const root = process.cwd(), token = randomUUID(), dir = path.join(root, ".spawn", "processes", token);
    fs.mkdirSync(dir, { recursive: true });
    writeSnapshot(path.join(dir, "intent.json"), JSON.stringify({ version: 1, token, ownerPid: process.pid, agent: toolOwner.getStore(), createdAt: Date.now() }));
    writeSnapshot(path.join(dir, "lease"), "alive\n");
    const lease = setInterval(() => { try { const now = new Date(); fs.utimesSync(path.join(dir, "lease"), now, now); } catch { /* supervisor cancels on expired lease */ } }, 1000);
    lease.unref();
    if (options.invocation) writeSnapshot(path.join(dir,"invocation.json"),JSON.stringify(options.invocation));
    const childEnv = { ...(options.env ?? process.env) }; delete childEnv.NODE_TEST_CONTEXT; // A project test run is independent of the host's node:test runner.
    if (path.resolve(options.cwd ?? process.cwd()) !== path.resolve(process.cwd())) childEnv.GIT_CEILING_DIRECTORIES = process.cwd();
    const child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE, "--", token, dir, options.invocation ? "@spawn-file" : command, path.resolve(options.cwd ?? process.cwd()), String(process.pid)], {
      env: childEnv,
      cwd: options.cwd, windowsHide: true,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = 1024 * 1024;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let stopped: string | undefined;
    const append = (old: Buffer, next: Buffer) => {
      const joined = Buffer.concat([old, next]);
      return joined.length <= cap ? joined : Buffer.concat([joined.subarray(0, cap / 2), joined.subarray(-cap / 2)]);
    };
    child.stdout.on("data", (data: Buffer) => { stdout = append(stdout, data); });
    child.stderr.on("data", (data: Buffer) => { stderr = append(stderr, data); });
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      requestProcessCancel(dir);
    };
    const abort = () => stop("Tool cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("Command timed out"), options.timeout ?? 60_000);
    const cleanup = () => { clearTimeout(timer); clearInterval(lease); signal?.removeEventListener("abort", abort); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (status) => {
      cleanup();
      let record: any;
      try {
        try { record = JSON.parse(fs.readFileSync(path.join(dir, "record.json"), "utf8")); }
        catch (error: any) { if (error.code !== "ENOENT") throw error; record = JSON.parse(fs.readFileSync(path.join(root, ".spawn", "processes", "completed", token, "record.json"), "utf8")); }
        if (!["completed", "cancelled", "failed"].includes(record.status)) throw new Error("Supervisor exited without confirming process tree termination");
        archiveFinishedProcess(root, token);
      } catch (error) {
        try { writeSnapshot(path.join(dir, "record.json"), JSON.stringify({ ...record, token, pid: child.pid, status: "blocked", reason: String(error) })); } catch { /* The persisted nonterminal record also blocks subsequent execution. */ }
        reject(Object.assign(new Error("Process tree termination is unconfirmed; inspect process registry before executing more tools"), { code: "unconfirmed_process", stdout, stderr })); return;
      }
      if (stopped || status !== 0) {
        reject(Object.assign(new Error(stopped ?? `Command failed (exit ${status})`), {
          code: stopped === "Tool cancelled" ? "ABORT_ERR" : status,
          stdout, stderr: stopped ? Buffer.concat([stderr, Buffer.from(`\n${stopped}`)]) : stderr,
        }));
      } else resolve(options.stdoutOnly ? stdout : Buffer.concat([stdout, stderr]));
    });
    if (signal?.aborted) abort();
  });
}
