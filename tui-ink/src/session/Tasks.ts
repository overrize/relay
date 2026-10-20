import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sessionJournal, type SessionJournal, type Entry, type CurrentState } from "./Journal.js";
import type { TuiEvent } from "../protocol.js";
import { WorkspaceBoundary } from "../execution/WorkspaceBoundary.js";
import { agentFile, type IsolatedWorkspace } from "./Workspaces.js";

export type WorkerProfile = "implement" | "research" | "review" | "verify";
export interface AcceptanceCheck { criterion: number; type: "file_contains" | "file_sha256" | "test_suite"; path: string; value?: string }
export interface TaskOperation { key: string; agent: string; name: string; signature: string; mutation: boolean; path?: string; startedSeq?: number; status: "pending" | "completed" | "uncertain"; ok?: boolean; output?: string; guard?: { path: string; sha256: string }; reconciliation?: { reviewer: string; evidence: string[]; reason: string; at: number } }
export interface WorkItem {
  isolation?: "snapshot" | "shared"; workspace?: IsolatedWorkspace;
  id: string; conversation: string; revision: number; parent: string; goal: string; profile: WorkerProfile;
  dispatch: any; checks: AcceptanceCheck[]; latestAgent: string; attempts: string[];
  mode: "auto" | "manual"; maxAttempts: number; maxTurns: number; maxTools: number; maxRequests: number;
  usedTurns: number; usedTools: number; usedRequests: number; createdAt: number; deadline: number; nextAt?: number;
  status: "running" | "evaluating" | "retry_wait" | "blocked" | "awaiting_review" | "accepted" | "exhausted" | "superseded";
  retryRequested?: boolean;
  reason: string; operations: Record<string, TaskOperation>; verdict?: { passed: boolean; details: string[]; at: number; reviewer: string };
}
export const readTools = new Set(["Read", "Glob", "Grep", "LS", "CodeMap", "FindReferences", "Think", "WebSearch", "WebFetch", "SessionRecall", "TaskStatus", "SubscriptionUsage", "BudgetStatus", "WorkspaceStatus"]);
export const fileHash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const bounded = (value: unknown, fallback: number, max: number) => value === undefined ? fallback : (Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max ? Number(value) : (() => { throw new Error(`Task budget must be an integer in 1..${max}`); })());
export function workItems(j = sessionJournal(), conversation?: string): WorkItem[] {
  return (conversation ? [j.current(conversation)] : j.bindings().filter((b) => !b.parent).map((b) => j.current(b.conversation))).flatMap((s) => Object.values(s?.work ?? {}));
}
export function taskFor(agent: string, j = sessionJournal()) { const b = j.binding(agent); return b?.workId ? j.current(b.conversation)?.work?.[b.workId] : undefined; }
export function taskState(t: WorkItem, patch: Partial<WorkItem>, j = sessionJournal()) {
  j.append("task.state", t.conversation, t.parent, t.revision, { id: t.id, patch });
}
export function normalizeContract(dispatch: any) {
  if (!["snapshot", "shared"].includes(process.env.SPAWN_WORKSPACE_ISOLATION ?? "snapshot")) throw new Error("Invalid SPAWN_WORKSPACE_ISOLATION");
  const recovery = dispatch?.recovery ?? {};
  if (recovery.mode !== undefined && !["auto", "manual"].includes(recovery.mode)) throw new Error("recovery.mode must be auto or manual");
  const profile = dispatch?.worker_profile ?? "implement";
  if (!["implement", "research", "review", "verify"].includes(profile)) throw new Error("Unknown worker_profile");
  const checks: AcceptanceCheck[] = dispatch?.acceptance_checks ?? [];
  if (!Array.isArray(checks) || checks.length > 12 || checks.some((c) => !c || !["file_contains", "file_sha256", "test_suite"].includes(c.type) || typeof c.path !== "string" || !c.path || c.path.length > 500 || (c.type !== "test_suite" && (typeof c.value !== "string" || !c.value || c.value.length > 8000)) || !Number.isSafeInteger(c.criterion) || c.criterion < 0 || c.criterion >= (dispatch?.acceptance_criteria?.length ?? 0) || (c.type === "file_sha256" && !/^[a-f0-9]{64}$/i.test(c.value!)))) throw new Error("Invalid acceptance_checks contract");
  return { profile: profile as WorkerProfile, checks, mode: (recovery.mode ?? "auto") as "auto" | "manual", maxAttempts: bounded(recovery.max_attempts, 2, 3), maxTurns: bounded(recovery.max_turns, 40, 80), maxRequests: bounded(recovery.max_requests, 60, 120), maxTools: bounded(recovery.max_tools, 80, 160), totalMs: bounded(recovery.total_ms, 20 * 60000, 60 * 60000) };
}
export function reserveAttempt(t: WorkItem, agent: string, j = sessionJournal()) {
  const fresh = j.current(t.conversation)?.work?.[t.id]; if (!fresh || fresh.revision !== j.current(t.conversation)?.revision) throw new Error("Obsolete task revision");
  const total = workItems(j, t.conversation).filter((w) => w.revision === t.revision).reduce((n, w) => n + w.attempts.length, 0);
  const cap = bounded(Number(process.env.SPAWN_TASK_ATTEMPTS_PER_REVISION ?? 12), 12, 100);
  if (fresh.attempts.length >= fresh.maxAttempts || fresh.usedTurns >= fresh.maxTurns || fresh.usedRequests >= fresh.maxRequests || fresh.usedTools >= fresh.maxTools || Date.now() >= fresh.deadline || total >= cap) {
    taskState(fresh, { status: "exhausted", reason: total >= cap ? "conversation-attempt-budget" : "task-budget-exhausted" }, j); throw new Error("Persistent task retry/time/turn/tool budget exhausted");
  }
  j.append("task.attempt", t.conversation, t.parent, t.revision, { id: t.id, agent });
}
export function admitWorker(e: Extract<TuiEvent, { type: "spawn" }>) {
  if (e.role !== "Worker") return;
  const j = sessionJournal(), parent = j.binding(e.parent); if (!parent) return;
  const revision = j.currentRevision(e.parent)!;
  const id = fileHash(`${parent.conversation}\0${revision}\0${e.goal.trim().replace(/\s+/g, " ")}`).slice(0, 24);
  const existing = j.current(parent.conversation)?.work?.[id];
  if (existing) throw new Error(`Logical task ${id} already exists (${existing.status}); use TaskStatus / TaskRetry instead of resetting its budget with a new Worker ID`);
  const contract = normalizeContract(e.dispatch), now = Date.now();
  const item: WorkItem = { id, conversation: parent.conversation, revision, parent: e.parent, goal: e.goal, dispatch: structuredClone(e.dispatch), profile: contract.profile, checks: contract.checks, mode: contract.mode, maxAttempts: contract.maxAttempts, maxTurns: contract.maxTurns, maxTools: contract.maxTools, maxRequests: contract.maxRequests, usedTurns: 0, usedTools: 0, usedRequests: 0, createdAt: now, deadline: now + contract.totalMs, latestAgent: e.child, attempts: [], status: "running", reason: "initial-dispatch", operations: {} };
  item.isolation = (process.env.SPAWN_WORKSPACE_ISOLATION ?? "snapshot") as "snapshot" | "shared";
  j.append("task.created", item.conversation, e.parent, revision, item); reserveAttempt(item, e.child, j);
}
export function consumeTaskTurn(agent: string) {
  const j = sessionJournal(), t = taskFor(agent, j); if (!t) return true;
  if (t.latestAgent !== agent || t.status === "superseded" || t.status === "accepted" || t.usedTurns >= t.maxTurns || Date.now() >= t.deadline) return false;
  j.append("task.turn", t.conversation, agent, t.revision, { id: t.id }); return true;
}
export function consumeTaskRequest(agent: string) {
  const j = sessionJournal(), t = taskFor(agent, j); if (!t) return true;
  if (t.latestAgent !== agent || t.status !== "running" || t.usedRequests >= t.maxRequests || Date.now() >= t.deadline) return false;
  j.append("task.request", t.conversation, agent, t.revision, { id: t.id }); return true;
}
export function checkedFile(file: string, root = process.cwd()) {
  const result = new WorkspaceBoundary(root).resolveInside(file);
  if (!result.ok) throw new Error(`Acceptance/effect path rejected: ${result.reason}`);
  if (!new WorkspaceBoundary(fs.realpathSync(root)).resolveInside(fs.realpathSync(result.path)).ok) throw new Error("File verification may not follow links outside the workspace");
  const stat = fs.statSync(result.path); if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("File verification requires a regular file no larger than 8 MiB");
  const bytes = fs.readFileSync(result.path); return { path: path.relative(root, result.path), sha256: fileHash(bytes), bytes };
}
export function checkedDirectory(dir: string, root = process.cwd()) {
  const result = new WorkspaceBoundary(root).resolveInside(dir);
  if (!result.ok || !new WorkspaceBoundary(fs.realpathSync(root)).resolveInside(fs.realpathSync(result.path)).ok || !fs.statSync(result.path).isDirectory()) throw new Error("Test suite directory must remain inside the workspace");
  return result.path;
}
export function safeToRetry(t: WorkItem): string | undefined {
  const acceptance = Object.entries(sessionJournal().current(t.conversation)?.tools ?? {}).find(([key, tool]) => key.includes(`:accept-${t.id}-`) && tool.name === "RunTests" && (tool.status === "pending" || tool.status === "uncertain"));
  if (acceptance) return `acceptance-needs-inspection:${acceptance[0]}`;
  const latest = new Map<string, TaskOperation>();
  for (const op of Object.values(t.operations)) {
    if (op.mutation && !op.reconciliation && (op.status !== "completed" || !op.ok || !op.guard)) return `effect-needs-inspection:${op.name}:${op.key}`;
    if (op.guard) latest.set(op.guard.path, op);
  }
  for (const op of latest.values()) try { if (checkedFile(op.guard!.path).sha256 !== op.guard!.sha256) return `effect-changed:${op.guard!.path}`; } catch { return `effect-missing:${op.guard!.path}`; }
}
export function beginTaskOperation(agent: string, callId: string | undefined, name: string, args: Record<string, unknown>) {
  const j = sessionJournal(), t = taskFor(agent, j); if (!t) return {};
  if (t.latestAgent !== agent || t.status !== "running" || t.usedTools >= t.maxTools || Date.now() >= t.deadline) return { blocked: "Persistent task tool/time budget exhausted or task is no longer running" };
  if ((t.profile === "research" || t.profile === "review") && !readTools.has(name)) return { blocked: `Profile ${t.profile} only permits read/search tools` };
  if (t.profile === "verify" && !readTools.has(name) && !["RunTests", "TypeCheck"].includes(name)) return { blocked: "Profile verify permits read/search, RunTests and TypeCheck only" };
  if (name.startsWith("Task") && name !== "TaskStatus") return { blocked: "Workers cannot control task recovery or acceptance" };
  const mutation = !readTools.has(name), normalized = { ...args };
  if ((name === "Write" || name === "Edit") && typeof (args.path ?? args.file_path) === "string") { const resolved = path.resolve(String(args.path ?? args.file_path)); normalized.path = process.platform === "win32" ? resolved.toLowerCase() : resolved; delete normalized.file_path; }
  if (name === "Bash") { delete normalized.timeout; normalized.command = String(args.command ?? args.cmd ?? "").trim(); delete normalized.cmd; }
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, stable(v[key])])) : v;
  const signature = fileHash(JSON.stringify({ name, args: stable(normalized) }));
  const prior = Object.values(t.operations).reverse().find((op) => op.agent !== agent && op.signature === signature && op.mutation);
  if (prior) {
    if (prior.reconciliation && !prior.guard) return { cached: `PM independently inspected and marked this operation DO NOT REPEAT; no command was run.\n${prior.reconciliation.reason}` };
    if (prior.status === "completed" && prior.ok && prior.guard && checkedFile(prior.guard.path).sha256 === prior.guard.sha256) return { cached: `Verified completed operation from ${prior.agent}; not repeated.\n${prior.output ?? ""}` };
    return { blocked: "Previous attempt has an unverified or changed effect; inspect it instead of repeating the operation" };
  }
  const key = `${agent}:${callId ?? `operation-${t.usedTools + 1}`}`;
  if (t.operations[key]) return { blocked: "Operation ID was already used in this logical task; inspect TaskStatus before retrying" };
  j.append("task.operation.started", t.conversation, agent, t.revision, { id: t.id, operation: { key, agent, name, signature, mutation, path: (name === "Write" || name === "Edit") ? path.relative(process.cwd(), String(normalized.path)) : undefined, status: "pending" } });
  return { key };
}
export function finishTaskOperation(agent: string, key: string, name: string, args: Record<string, unknown>, result: { ok: boolean; output: string }) {
  const j = sessionJournal(), t = taskFor(agent, j); if (!t) return;
  let guard: TaskOperation["guard"];
  if (result.ok && (name === "Write" || name === "Edit")) try { const f = checkedFile(agentFile(agent, String(args.path ?? args.file_path))); guard = { path: f.path, sha256: f.sha256 }; } catch { /* Unverified writes prevent automatic retry. */ }
  j.append("task.operation.finished", t.conversation, agent, t.revision, { id: t.id, key, ok: result.ok, output: result.output.slice(-1200), guard });
}
/** Reducer lives beside its schema; every controller transition is journaled. */
export function reduceTask(s: CurrentState, e: Entry) {
  if (e.kind === "requirement.changed") for (const t of Object.values(s.work ?? {})) if (t.revision !== e.revision) { t.status = "superseded"; t.reason = "requirement-superseded"; }
  if (e.kind === "task.created" && e.revision === s.revision) (s.work ??= {})[e.data.id] ??= e.data;
  if (e.kind === "runtime.event" && e.data.type === "agent.done" && e.revision === s.revision) for (const t of Object.values(s.work ?? {})) if (t.latestAgent === e.agent) for (const op of Object.values(t.operations)) if (op.status === "pending") op.status = "uncertain";
  if (e.kind === "workspace.abandoned") { const old = s.work?.[e.data.id]; if (old?.workspace && old.revision === e.revision) Object.assign(old.workspace, { pending: null, status: "conflict", conflicts: e.data.conflicts }); }
  const t = s.work?.[e.data?.id]; if (!t || e.revision !== s.revision || t.revision !== e.revision) return;
  if (e.kind === "task.state") Object.assign(t, e.data.patch);
  if (e.kind === "task.attempt") { t.attempts.push(e.data.agent); t.latestAgent = e.data.agent; t.status = "running"; t.reason = "attempt-reserved"; t.nextAt = undefined; }
  if (e.kind === "task.turn") t.usedTurns++;
  if (e.kind === "task.request") t.usedRequests++;
  if (e.kind === "task.operation.started") { t.usedTools++; t.operations[e.data.operation.key] = { ...e.data.operation, startedSeq: e.seq }; }
  if (e.kind === "task.operation.finished") { const op = t.operations[e.data.key]; if (op) Object.assign(op, { status: "completed", ok: e.data.ok, output: e.data.output, guard: e.data.guard }); }
  if (e.kind === "task.operation.reconciled") { const op = t.operations[e.data.key]; if (op) Object.assign(op, { status: "completed", ok: true, guard: e.data.guard, reconciliation: e.data.reconciliation }); }
}
