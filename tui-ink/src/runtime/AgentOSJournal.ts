import { writeSnapshot } from "../memory/atomic.js";
import { orchestrationMode, type OrchestrationMode } from "../pm/mode.js";
import * as fs from "node:fs";
import * as path from "node:path";

export type AgentOSRole = "user" | "pm" | "leader" | "worker" | "secretary" | "system";

export type AgentOSCommand =
  | "task.assign"
  | "task.progress"
  | "task.result"
  | "task.fail"
  | "task.cancel"
  | "ctx.provide"
  | "ctx.request"
  | "ctx.patch"
  | "tool.request"
  | "tool.result"
  | "finding.report"
  | "decision.record"
  | "artifact.produce"
  | "exception.report"
  | "wiki.patch"
  | "question.ask"
  | "question.answer"
  | "agent.spawn"
  | "agent.done"
  | "agent.heartbeat";

export type AgentOSPriority = "control" | "high" | "normal" | "low";
export type AgentOSVisibility = "private" | "task" | "repo" | "org";
export type AgentOSConfidence = "confirmed" | "inferred" | "stale";

export interface AgentOSAddress {
  id: string;
  role: AgentOSRole;
}

export interface AgentOSEnvelope<TPayload = unknown> {
  id: string;
  trace_id: string;
  task_id: string;
  parent_id?: string;
  from: AgentOSAddress;
  to: AgentOSAddress;
  cmd: AgentOSCommand;
  seq: number;
  priority: AgentOSPriority;
  scope: string;
  visibility: AgentOSVisibility;
  deadline_ms?: number;
  payload: TPayload;
  refs: string[];
  created_at: number;
}

export interface WikiCandidate {
  id: string;
  source_cmd_id: string;
  task_id: string;
  kind: "finding" | "decision" | "artifact" | "exception";
  title: string;
  body: string;
  scope: string;
  confidence: AgentOSConfidence;
  refs: string[];
  created_at: number;
}

export interface AgentOSJournalSnapshot {
  version: 1;
  next_seq: number;
  entries: AgentOSEnvelope[];
  wiki_candidates: WikiCandidate[];
}

export interface RouteDecision {
  ok: boolean;
  code?: string;
  detail?: string;
}

const WRITABLE_TO_USER = new Set<AgentOSCommand>(["task.result", "task.fail", "question.answer"]);
const WORKER_TO_LEADER = new Set<AgentOSCommand>([
  "task.progress",
  "task.result",
  "task.fail",
  "tool.result",
  "finding.report",
  "artifact.produce",
  "exception.report",
  "question.ask",
  "agent.done",
  "agent.heartbeat",
]);
const LEADER_TO_WORKER = new Set<AgentOSCommand>([
  "agent.spawn",
  "task.assign",
  "task.cancel",
  "ctx.provide",
  "ctx.request",
  "tool.request",
  "question.answer",
]);
const PM_TO_LEADER = new Set<AgentOSCommand>([
  "task.assign",
  "task.cancel",
  "ctx.provide",
  "ctx.request",
  "question.answer",
  "agent.spawn",
]);
const LEADER_TO_PM = new Set<AgentOSCommand>([
  "task.progress",
  "task.result",
  "task.fail",
  "finding.report",
  "decision.record",
  "artifact.produce",
  "exception.report",
  "question.ask",
  "agent.done",
  "agent.heartbeat",
]);
const SECRETARY_CMDS = new Set<AgentOSCommand>(["wiki.patch", "ctx.provide", "decision.record", "exception.report"]);

export function validateRoute(env: AgentOSEnvelope, mode: OrchestrationMode = "hierarchical"): RouteDecision {
  if (!env.id || !env.trace_id || !env.task_id) {
    return { ok: false, code: "missing_identity", detail: "id, trace_id and task_id are required" };
  }
  if (!env.from.id || !env.to.id) {
    return { ok: false, code: "missing_address", detail: "from.id and to.id are required" };
  }
  if (env.from.role === "worker" && env.to.role === "user") {
    return { ok: false, code: "worker_to_user_blocked", detail: "Worker cannot send commands directly to user" };
  }
  if (mode === "adaptive" && env.from.role === "worker" && env.to.role === "pm") return allow(new Set([...WORKER_TO_LEADER, "ctx.provide"]), env.cmd);
  if (mode === "adaptive" && env.from.role === "pm" && env.to.role === "worker") return allow(LEADER_TO_WORKER, env.cmd);
  if (env.from.role === "worker" && env.to.role === "pm") {
    return { ok: false, code: "worker_to_pm_blocked", detail: "Worker must report through its Leader" };
  }
  if (env.to.role === "system") {
    return env.cmd === "agent.done" || env.cmd === "exception.report" || env.cmd === "agent.heartbeat"
      ? { ok: true }
      : { ok: false, code: "invalid_system_cmd", detail: `${env.cmd} cannot be delivered to system` };
  }
  if (env.to.role === "user") {
    return WRITABLE_TO_USER.has(env.cmd)
      ? { ok: true }
      : { ok: false, code: "invalid_user_cmd", detail: `${env.cmd} cannot be delivered to user` };
  }
  if (env.from.role === "pm" && env.to.role === "leader") return allow(PM_TO_LEADER, env.cmd);
  if (env.from.role === "leader" && env.to.role === "worker") return allow(LEADER_TO_WORKER, env.cmd);
  if (env.from.role === "worker" && env.to.role === "leader") return allow(WORKER_TO_LEADER, env.cmd);
  if (env.from.role === "leader" && env.to.role === "pm") return allow(LEADER_TO_PM, env.cmd);
  if (env.from.role === "secretary" || env.to.role === "secretary") return allow(SECRETARY_CMDS, env.cmd);
  if (env.from.role === "system") return { ok: true };
  return { ok: false, code: "route_not_allowed", detail: `${env.from.role} -> ${env.to.role} ${env.cmd}` };
}

function allow(allowed: Set<AgentOSCommand>, cmd: AgentOSCommand): RouteDecision {
  return allowed.has(cmd)
    ? { ok: true }
    : { ok: false, code: "cmd_not_allowed", detail: `${cmd} is not allowed on this route` };
}

export interface CreateEnvelopeInput<TPayload> {
  trace_id: string;
  task_id: string;
  parent_id?: string;
  from: AgentOSAddress;
  to: AgentOSAddress;
  cmd: AgentOSCommand;
  priority?: AgentOSPriority;
  scope?: string;
  visibility?: AgentOSVisibility;
  deadline_ms?: number;
  payload: TPayload;
  refs?: string[];
  created_at?: number;
}

export class AgentOSJournal {
  private snapshot: AgentOSJournalSnapshot;

  constructor(private readonly filePath: string, private readonly mode?: OrchestrationMode) {
    this.snapshot = this.load();
  }

  create<TPayload>(input: CreateEnvelopeInput<TPayload>): AgentOSEnvelope<TPayload> {
    return {
      id: `cmd-${Date.now().toString(36)}-${this.snapshot.next_seq.toString(36)}`,
      trace_id: input.trace_id,
      task_id: input.task_id,
      parent_id: input.parent_id,
      from: input.from,
      to: input.to,
      cmd: input.cmd,
      seq: this.snapshot.next_seq,
      priority: input.priority ?? "normal",
      scope: input.scope ?? "task",
      visibility: input.visibility ?? "task",
      deadline_ms: input.deadline_ms,
      payload: input.payload,
      refs: input.refs ?? [],
      created_at: input.created_at ?? Date.now(),
    };
  }

  append<TPayload>(env: AgentOSEnvelope<TPayload>): RouteDecision {
    const route = validateRoute(env, this.mode ?? orchestrationMode());
    if (!route.ok) return route;
    this.snapshot.entries.push(env as AgentOSEnvelope);
    this.snapshot.next_seq = Math.max(this.snapshot.next_seq, env.seq + 1);
    const candidate = toWikiCandidate(env);
    if (candidate) this.snapshot.wiki_candidates.push(candidate);
    this.save();
    return { ok: true };
  }

  entries(): readonly AgentOSEnvelope[] {
    return this.snapshot.entries;
  }

  wikiCandidates(): readonly WikiCandidate[] {
    return this.snapshot.wiki_candidates;
  }

  private load(): AgentOSJournalSnapshot {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as AgentOSJournalSnapshot;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
    } catch {
      // Start a fresh journal if the file does not exist or is not readable.
    }
    return { version: 1, next_seq: 1, entries: [], wiki_candidates: [] };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeSnapshot(this.filePath, JSON.stringify(this.snapshot, null, 2));
  }
}

function toWikiCandidate(env: AgentOSEnvelope): WikiCandidate | null {
  if (env.cmd === "finding.report") {
    const payload = env.payload as { claim?: string; evidence?: unknown[]; confidence?: AgentOSConfidence };
    if (!payload.claim) return null;
    return {
      id: `wiki-${env.id}`,
      source_cmd_id: env.id,
      task_id: env.task_id,
      kind: "finding",
      title: payload.claim.slice(0, 120),
      body: JSON.stringify(payload, null, 2),
      scope: env.scope,
      confidence: payload.confidence ?? "inferred",
      refs: env.refs,
      created_at: env.created_at,
    };
  }
  if (env.cmd === "decision.record") {
    const payload = env.payload as { decision?: string; reason?: string; confidence?: AgentOSConfidence };
    if (!payload.decision) return null;
    return {
      id: `wiki-${env.id}`,
      source_cmd_id: env.id,
      task_id: env.task_id,
      kind: "decision",
      title: payload.decision.slice(0, 120),
      body: JSON.stringify(payload, null, 2),
      scope: env.scope,
      confidence: payload.confidence ?? "confirmed",
      refs: env.refs,
      created_at: env.created_at,
    };
  }
  if (env.cmd === "artifact.produce") {
    const payload = env.payload as { path?: string; summary?: string; confidence?: AgentOSConfidence };
    if (!payload.path && !payload.summary) return null;
    return {
      id: `wiki-${env.id}`,
      source_cmd_id: env.id,
      task_id: env.task_id,
      kind: "artifact",
      title: (payload.path ?? payload.summary ?? "artifact").slice(0, 120),
      body: JSON.stringify(payload, null, 2),
      scope: env.scope,
      confidence: payload.confidence ?? "confirmed",
      refs: env.refs,
      created_at: env.created_at,
    };
  }
  if (env.cmd === "exception.report") {
    const payload = env.payload as { title?: string; detail?: string; confidence?: AgentOSConfidence };
    if (!payload.title && !payload.detail) return null;
    return {
      id: `wiki-${env.id}`,
      source_cmd_id: env.id,
      task_id: env.task_id,
      kind: "exception",
      title: (payload.title ?? payload.detail ?? "exception").slice(0, 120),
      body: JSON.stringify(payload, null, 2),
      scope: env.scope,
      confidence: payload.confidence ?? "confirmed",
      refs: env.refs,
      created_at: env.created_at,
    };
  }
  return null;
}
