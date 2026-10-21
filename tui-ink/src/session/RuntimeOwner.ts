import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const owners = new Map<string, () => void>();
export class WorkspaceOwnershipError extends Error {
  constructor(message:string,readonly ownerPid?:number){super(message);this.name='WorkspaceOwnershipError';}
}
export function ownershipNotice(error:unknown):string{
  if(error instanceof WorkspaceOwnershipError)return `工作区暂不可用${error.ownerPid?`（占用进程 PID ${error.ownerPid}）`:''}。${error.ownerPid?'请返回已有 Relay 窗口；如需重新启动，先在原窗口正常退出。':'工作区所有权记录需要检查，请稍后重试或检查 .spawn 下的所有权记录。'}未启动新的执行，也未删除锁或终止已有任务。`;
  return '本次操作未完成；请检查配置、工作区权限和日志后重试。';
}
export function acquireWorkspaceOwnership(root: string, kind: "runtime" | "restore") {
  const file = path.join(root, ".spawn", "runtime-owner.json"), token = randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const transition = path.join(root, ".spawn", "ownership-transition.lock");
  let gate: number;
  try { gate = fs.openSync(transition, "wx", 0o600); }
  catch (error: any) { if (error.code === "EEXIST") throw new WorkspaceOwnershipError("Workspace ownership transition is busy or interrupted; inspect ownership-transition.lock before retrying"); throw error; }
  try {
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid workspace ownership record; inspect before retrying");
    let dead = false; try { process.kill(owner.pid, 0); } catch (e: any) { if (e.code === "ESRCH") dead = true; else throw e; }
    if (!dead) throw new WorkspaceOwnershipError(kind === "restore" ? "Stop the running application before restoring this workspace" : "Another application or restore owns this workspace",owner.pid);
    // Reclaim a dead owner only if the record has not been replaced meanwhile.
    if (JSON.parse(fs.readFileSync(file, "utf8")).token !== owner.token) throw new Error("Workspace owner changed; retry later");
    fs.unlinkSync(file); fd = fs.openSync(file, "wx", 0o600);
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, kind, startedAt: Date.now() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return () => { try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file); } catch { /* Preserved if ownership changed. */ } };
  } finally { fs.closeSync(gate); fs.unlinkSync(transition); }
}
export function registerRuntimeOwner(root = process.cwd()) {
  root = path.resolve(root);
  if (owners.has(root)) return;
  owners.set(root, acquireWorkspaceOwnership(root, "runtime"));
}
export function releaseRuntimeOwners() {
  for (const release of owners.values()) release();
  owners.clear();
}
