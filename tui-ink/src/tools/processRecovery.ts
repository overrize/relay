import fs from "node:fs";
import path from "node:path";
import { writeSnapshot } from "../memory/atomic.js";

export interface ProcessIntent { version: 1; token: string; ownerPid: number; agent?: string; createdAt: number }
export interface ProcessRecord { token: string; pid?: number; childPid?: number; status: string; reason?: string }
const terminal = new Set(["completed", "cancelled", "failed", "abandoned"]);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e: any) { if (e.code === "ESRCH") return false; throw e; } }
export function requestProcessCancel(dir: string): void { writeSnapshot(path.join(dir, "cancel"), "cancel\n"); }
export function archiveFinishedProcess(root: string, token: string): void {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid process capability");
  const parent = path.join(root, ".spawn", "processes"), source = path.join(parent, token);
  try {
    if (fs.lstatSync(source).isSymbolicLink()) throw new Error("Process directory must not be a symbolic link");
    fs.mkdirSync(path.join(parent, "completed"), { recursive: true });
    fs.renameSync(source, path.join(parent, "completed", token));
  } catch (error: any) { if (error.code !== "ENOENT") throw error; }
}

/** Recovery requests go only to a persisted random capability, never a saved PID.
 * A reused PID, or a tampered record pointing at another process, is never killed. */
export async function recoverOrphanCommands(root = process.cwd(), timeout = 10000) {
  const directory = path.join(root, ".spawn", "processes");
  const results: Array<{ token: string; status: string }> = [];
  let names: string[];
  try { names = await fs.promises.readdir(directory); } catch (e: any) { if (e.code === "ENOENT") return results; throw e; }
  for (const token of names) {
    if (!/^[a-f0-9-]{36}$/.test(token)) continue;
    try {
    const dir = path.join(directory, token);
    if ((await fs.promises.lstat(dir)).isSymbolicLink()) throw new Error("Process registry contains a symbolic link; inspect before executing tools");
    const intent = JSON.parse(await fs.promises.readFile(path.join(dir, "intent.json"), "utf8")) as ProcessIntent;
    if (intent.version !== 1 || intent.token !== token || !Number.isSafeInteger(intent.ownerPid) || intent.ownerPid <= 0) throw new Error(`Invalid process intent ${token}`);
    let record: ProcessRecord | undefined;
    try { record = JSON.parse(await fs.promises.readFile(path.join(dir, "record.json"), "utf8")); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (record && record.token !== token) throw new Error(`Process capability mismatch ${token}`);
    if (record && terminal.has(record.status)) { archiveFinishedProcess(root, token); continue; }
    if (record?.status === "blocked") throw new Error(`Orphan ${token} needs inspection: process tree termination is unconfirmed`);
    if (record?.pid && !alive(record.pid)) {
      // The supervisor publishes its terminal record before exiting. A record
      // read before the liveness check can therefore be stale by this point.
      record = JSON.parse(await fs.promises.readFile(path.join(dir, "record.json"), "utf8"));
      if (record?.token !== token) throw new Error(`Process capability mismatch ${token}`);
      if (terminal.has(record.status)) { archiveFinishedProcess(root, token); continue; }
      throw new Error(`Orphan ${token} needs inspection: supervisor exited without confirming tree termination`);
    }
    const lease = await fs.promises.stat(path.join(dir, "lease")).catch(() => undefined);
    if (alive(intent.ownerPid) && lease && Date.now() - lease.mtimeMs < 15000) continue;
    requestProcessCancel(dir);
    // Intent is persisted before spawn. A supervisor not yet started checks this
    // cancel file before creating a shell, so a missing record is safely abandoned.
    if (!record) { results.push({ token, status: "abandoned" }); continue; }
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      record = JSON.parse(await fs.promises.readFile(path.join(dir, "record.json"), "utf8"));
      if (record?.token !== token) throw new Error(`Process capability mismatch ${token}`);
      if (terminal.has(record.status)) break;
      if (record.status === "blocked") throw new Error(`Orphan ${token} needs inspection: supervisor cannot confirm tree termination`);
      if (record.pid && !alive(record.pid)) {
        record = JSON.parse(await fs.promises.readFile(path.join(dir, "record.json"), "utf8"));
        if (record?.token !== token) throw new Error(`Process capability mismatch ${token}`);
        if (terminal.has(record.status)) break;
        throw new Error(`Orphan ${token} needs inspection: supervisor cannot confirm tree termination`);
      }
      await pause(100);
    }
    if (!record || !terminal.has(record.status)) throw new Error(`Orphan cleanup timed out: ${token}; new tools remain blocked`);
    results.push({ token, status: record.status });
    archiveFinishedProcess(root, token);
    } catch (error: any) {
      // A concurrent successful completion may archive the entire directory.
      // Missing files inside a still-present operation are not evidence of exit.
      if (error.code !== "ENOENT") throw error;
      if (fs.existsSync(path.join(directory, token))) throw new Error(`Incomplete process registry ${token}; inspect before executing tools`);
    }
  }
  return results;
}
