import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sessionJournal } from "./Journal.js";
import { taskFor, taskState, workItems, fileHash, type WorkItem } from "./Tasks.js";
import { writeBuffer } from "./Storage.js";
import { WorkspaceBoundary } from "../execution/WorkspaceBoundary.js";

export interface IsolatedWorkspace { directory: string; base: Record<string, string>; status: "ready" | "conflict" | "merged"; conflicts: string[]; pending?: Array<{ path: string; before: string; after: string }> | null }
const scope = new AsyncLocalStorage<string>();
const locks = new Map<string, Promise<unknown>>();
const excluded = new Set([".git", ".spawn", "node_modules", ".test-tmp", ".venv", "venv"]);
export const toolWorkspace = () => scope.getStore() ?? process.cwd();
export function workspacePath(t: WorkItem) { return t.workspace ? path.resolve(process.cwd(), t.workspace.directory) : process.cwd(); }
export function agentFile(agent: string, file: string) {
  const t = taskFor(agent), root = process.cwd(); if (!t?.workspace) return file;
  if (path.isAbsolute(file) && new WorkspaceBoundary(workspacePath(t)).resolveInside(file).ok) return file;
  const resolved = new WorkspaceBoundary(root).resolveInside(file); if (!resolved.ok) throw new Error("Workspace path is outside the project");
  return path.join(workspacePath(t), path.relative(root, resolved.path));
}
function canonical(file: string) {
  const root = toolWorkspace(); let target = file;
  if (root !== process.cwd() && path.isAbsolute(file) && new WorkspaceBoundary(process.cwd()).resolveInside(file).ok && !new WorkspaceBoundary(root).resolveInside(file).ok) target = path.relative(process.cwd(), file);
  const resolved = new WorkspaceBoundary(root).resolveInside(target); if (!resolved.ok) throw new Error("Path is outside the active workspace");
  if (path.relative(root, resolved.path).split(path.sep).some((p) => excluded.has(p))) throw new Error("Managed/dependency paths may not be edited through workspace tools");
  let parent = resolved.path; while (!fs.existsSync(parent)) { const next = path.dirname(parent); if (next === parent) break; parent = next; }
  if (fs.existsSync(parent) && !new WorkspaceBoundary(fs.realpathSync(root)).resolveInside(fs.realpathSync(parent)).ok) throw new Error("Workspace path follows a link outside the project");
  return resolved.path;
}
export function resolveWorkspaceToolPath(file: string) { return canonical(file); }
export async function workspaceExclusive<T>(work: () => Promise<T>): Promise<T> {
  const root = process.cwd(), previous = locks.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work); locks.set(root, next);
  try { return await next; } finally { if (locks.get(root) === next) locks.delete(root); }
}
async function files(root: string) {
  const result: Record<string, string> = {}, maxFiles = Number(process.env.SPAWN_WORKSPACE_MAX_FILES ?? 10000), maxBytes = Number(process.env.SPAWN_WORKSPACE_MAX_BYTES ?? 134217728); let bytes = 0;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid workspace quota");
  async function walk(dir: string) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot refuses symbolic links: ${path.relative(root, file)}`);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) throw new Error("Snapshot refuses non-regular files");
      const stat = await fs.promises.stat(file); bytes += stat.size;
      if (Object.keys(result).length >= maxFiles || bytes > maxBytes) throw new Error("Workspace snapshot quota exceeded; narrow the project or increase its explicit quota");
      result[path.relative(root, file).split(path.sep).join("/")] = fileHash(await fs.promises.readFile(file));
    }
  }
  await walk(root); return result;
}
function file(root: string, rel: string) { const r = new WorkspaceBoundary(root).resolveInside(rel); if (!r.ok || rel.split(/[\\/]/).some((p) => excluded.has(p))) throw new Error("Invalid workspace manifest path"); let parent = r.path; while (!fs.existsSync(parent)) parent = path.dirname(parent); if (!new WorkspaceBoundary(fs.realpathSync(root)).resolveInside(fs.realpathSync(parent)).ok) throw new Error("Manifest path escapes through a link"); return r.path; }
async function hashAt(root: string, rel: string) { try { const p = file(root, rel); if (!(await fs.promises.lstat(p)).isFile()) throw new Error("Merge target is not a regular file"); return fileHash(await fs.promises.readFile(p)); } catch (e: any) { if (e.code === "ENOENT") return "missing"; throw e; } }
export async function prepareWorkspace(agent: string) {
  let t = taskFor(agent); if (!t || t.isolation !== "snapshot") return;
  if (t.workspace) return;
  await workspaceExclusive(async () => {
    t = taskFor(agent); if (!t || t.workspace) return;
    const j = sessionJournal(), base = await files(process.cwd()), directory = `.spawn/workspaces/${t.id}/${randomUUID()}/tree`, target = path.resolve(directory);
    await fs.promises.mkdir(target, { recursive: true });
    for (const rel of Object.keys(base)) { const bytes = await fs.promises.readFile(file(process.cwd(), rel)); if (fileHash(bytes) !== base[rel]) throw new Error(`Project changed during snapshot: ${rel}`); await writeBuffer(path.join(target, rel), bytes); }
    if (!j.isCurrent(agent, t.revision)) throw new Error("Requirement changed during workspace snapshot");
    taskState(t, { workspace: { directory, base, status: "ready", conflicts: [] } });
  });
}
export async function withWorkspace<T>(agent: string | undefined, tool: string, args: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  let task = agent ? taskFor(agent) : undefined;
  if (agent && args.task && ["Read", "Grep", "RunTests", "TypeCheck"].includes(tool)) {
    const b = sessionJournal().binding(agent), requested = workItems(sessionJournal(), b?.conversation).find((t) => t.id === args.task);
    if (!b || b.role !== "Leader" || !requested || (b.id !== requested.parent && b.id !== requested.conversation)) throw new Error("Only the task owner/root PM can inspect this isolated workspace");
    task = requested;
  }
  if (task?.isolation === "snapshot") {
    await prepareWorkspace(task.latestAgent); task = taskFor(task.latestAgent)!;
    if (!task.workspace) throw new Error("Isolated workspace is not ready");
    if (["Bash", "RunTests", "TypeCheck"].includes(tool) && task.workspace.pending) throw new Error("Workspace has an interrupted publish; finish recovery before running commands");
    return scope.run(workspacePath(task), run);
  }
  if (["Write", "Edit", "Bash", "RunTests", "TypeCheck"].includes(tool)) return workspaceExclusive(run);
  return run();
}
export async function workspaceChanges(t: WorkItem) {
  if (!t.workspace) return [];
  const stage = await files(workspacePath(t)), names = new Set([...Object.keys(t.workspace.base), ...Object.keys(stage)]), changes: Array<{ path: string; before: string; after: string; current: string }> = [];
  for (const rel of names) { const before = t.workspace.base[rel] ?? "missing", after = stage[rel] ?? "missing"; if (before !== after) changes.push({ path: rel, before, after, current: await hashAt(process.cwd(), rel) }); }
  return changes;
}
async function finishPublish(t: WorkItem) {
  const j = sessionJournal(), pending = t.workspace?.pending; if (!pending) return;
  if (!j.isCurrent(t.latestAgent, t.revision)) { j.append("workspace.abandoned", t.conversation, t.latestAgent, t.revision, { id: t.id, conflicts: pending.map((p) => `superseded partial publish:${p.path}`) }); return; }
  for (const row of pending) {
    const current = await hashAt(process.cwd(), row.path);
    if (current !== row.before && current !== row.after) throw new Error(`Publish recovery conflict: ${row.path}`);
    if (current === row.after) continue;
    if (!j.isCurrent(t.latestAgent, t.revision)) throw new Error("Requirement changed during publish; partial writes are preserved for inspection");
    const target = file(process.cwd(), row.path);
    if (row.after === "missing") await fs.promises.unlink(target);
    else { const bytes = await fs.promises.readFile(file(workspacePath(t), row.path)); if (fileHash(bytes) !== row.after) throw new Error("Staged content changed during publish"); await writeBuffer(target, bytes); }
  }
  const base = { ...t.workspace!.base }; for (const row of pending) { if (row.after === "missing") delete base[row.path]; else base[row.path] = row.after; }
  taskState(t, { workspace: { ...t.workspace!, base, status: "merged", conflicts: [], pending: null } });
}
export async function publishWorkspace(t: WorkItem) {
  if (!t.workspace) return;
  return workspaceExclusive(async () => {
    t = sessionJournal().current(t.conversation)?.work?.[t.id]!;
    if (!t || !sessionJournal().isCurrent(t.latestAgent, t.revision)) throw new Error("Cannot publish an obsolete task");
    if (t.workspace!.pending) { await finishPublish(t); return; }
    const changes = await workspaceChanges(t), conflicts = changes.filter((r) => r.current !== r.before && r.current !== r.after).map((r) => r.path);
    if (conflicts.length) { taskState(t, { status: "blocked", reason: "workspace-conflict", workspace: { ...t.workspace!, status: "conflict", conflicts } }); throw new Error(`Workspace conflict; both versions preserved: ${conflicts.join(", ")}`); }
    taskState(t, { workspace: { ...t.workspace!, pending: changes.map(({ path, before, after }) => ({ path, before, after })) } });
    await finishPublish(sessionJournal().current(t.conversation)!.work![t.id]!);
  });
}
export async function recoverWorkspacePublishes() {
  for (const t of workItems()) if (t.workspace?.pending) await workspaceExclusive(async () => {
    try { await finishPublish(t); } catch (error) {
      const fresh = sessionJournal().current(t.conversation)?.work?.[t.id] ?? t;
      taskState(fresh, { status: "blocked", reason: `workspace-publish-recovery: ${String(error)}`, workspace: { ...fresh.workspace!, status: "conflict", conflicts: fresh.workspace!.pending!.map((r) => r.path) } });
    }
  });
}
export async function resolveWorkspace(requester: string, id: string, rel: string, expected: string, choice: string) {
  const j = sessionJournal(), b = j.binding(requester), t = b && j.current(b.conversation)?.work?.[id];
  if (!t?.workspace || b?.role !== "Leader" || (requester !== t.parent && requester !== t.conversation) || !j.isCurrent(t.latestAgent, t.revision) || ["running", "evaluating", "retry_wait"].includes(t.status)) throw new Error("Only the current owner/root PM may resolve a stopped task");
  return workspaceExclusive(async () => {
    if (await hashAt(process.cwd(), rel) !== expected) throw new Error("Conflict target changed again; inspect before resolving");
    const base = { ...t.workspace!.base }; if (expected === "missing") delete base[rel]; else base[rel] = expected;
    if (choice === "theirs") { const target = file(workspacePath(t), rel); if (expected === "missing") await fs.promises.unlink(target).catch((e) => { if (e.code !== "ENOENT") throw e; }); else await writeBuffer(target, await fs.promises.readFile(file(process.cwd(), rel))); }
    else if (choice !== "ours") throw new Error("Resolution must be ours or theirs");
    taskState(t, { workspace: { ...t.workspace!, base, pending: t.workspace!.pending?.map((r) => r.path === rel ? { ...r, before: expected, after: choice === "theirs" ? expected : r.after } : r) ?? null, status: "ready", conflicts: t.workspace!.conflicts.filter((p) => p !== rel) }, reason: `PM resolved ${rel} using ${choice}` });
    j.append("workspace.resolved", t.conversation, requester, t.revision, { id, path: rel, expected, choice });
  });
}
