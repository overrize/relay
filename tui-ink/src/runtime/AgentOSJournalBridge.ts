import * as path from "node:path";
import type { TuiEvent, AgentInfo } from "../protocol.js";
import {
  AgentOSJournal,
  type AgentOSAddress,
  type AgentOSEnvelope,
  type AgentOSRole,
} from "./AgentOSJournal.js";

export interface AgentOSBridgeContext {
  getAgent(agentId: string): AgentInfo | undefined;
  now?: () => number;
}

export interface AgentOSBridgeOptions {
  journalPath?: string;
  enabled?: boolean;
}

export class AgentOSJournalBridge {
  private cachedJournal?: AgentOSJournal;
  private readonly journalPath: string;
  private get journal(): AgentOSJournal { return this.cachedJournal ??= new AgentOSJournal(this.journalPath); }
  private readonly enabled: boolean;

  constructor(options: AgentOSBridgeOptions = {}) {
    this.enabled = options.enabled ?? process.env.SPAWN_AGENT_OS_JOURNAL !== "0";
    this.journalPath = options.journalPath ?? path.join(process.cwd(), ".spawn", "agent-os", "journal.json");
  }

  observe(ev: TuiEvent, context: AgentOSBridgeContext): void {
    if (!this.enabled) return;
    // Managed sessions already have the durable segmented journal. Retain the
    // old full-JSON diagnostic rail only when explicitly requested.
    if (ev.session_revision !== undefined && process.env.SPAWN_AGENT_OS_JOURNAL !== "1") return;
    for (const env of eventToEnvelopes(ev, context)) {
      const result = this.journal.append(env);
      if (!result.ok) {
        process.stderr.write(
          `[AgentOSJournalBridge] route rejected ${env.cmd} ${env.from.id}->${env.to.id}: ${result.code} ${result.detail ?? ""}\n`,
        );
      }
    }
  }

  entries(): readonly AgentOSEnvelope[] {
    return this.journal.entries();
  }
}

let bridgeSeq = 0;

export function eventToEnvelopes(ev: TuiEvent, context: AgentOSBridgeContext): AgentOSEnvelope[] {
  const now = context.now?.() ?? Date.now();
  const make = <TPayload>(input: {
    trace_id?: string;
    task_id?: string;
    parent_id?: string;
    from: AgentOSAddress;
    to: AgentOSAddress;
    cmd: AgentOSEnvelope<TPayload>["cmd"];
    priority?: AgentOSEnvelope<TPayload>["priority"];
    scope?: string;
    visibility?: AgentOSEnvelope<TPayload>["visibility"];
    deadline_ms?: number;
    payload: TPayload;
    refs?: string[];
  }): AgentOSEnvelope<TPayload> => {
    const seq = ++bridgeSeq;
    return {
      id: `cmd-${now.toString(36)}-${seq.toString(36)}`,
      trace_id: input.trace_id ?? traceIdForEvent(ev),
      task_id: input.task_id ?? taskIdForEvent(ev),
      parent_id: input.parent_id,
      from: input.from,
      to: input.to,
      cmd: input.cmd,
      seq,
      priority: input.priority ?? "normal",
      scope: input.scope ?? "task",
      visibility: input.visibility ?? "task",
      deadline_ms: input.deadline_ms,
      payload: input.payload,
      refs: input.refs ?? [],
      created_at: now,
    };
  };

  switch (ev.type) {
    case "spawn": {
      const parent = addressFor(ev.parent, context);
      const child = addressFor(ev.child, context, roleForSpawn(ev.role));
      return [make({
        from: parent,
        to: child,
        cmd: "agent.spawn",
        scope: scopeForAgent(ev.parent),
        payload: {
          goal: ev.goal,
          role: ev.role,
          model: ev.model,
          dispatch: ev.dispatch,
        },
      })];
    }

    case "message": {
      const from = addressFor(ev.agent, context);
      const to = ev.to === "user" ? { id: "user", role: "user" as const } : addressFor(ev.to, context);
      return [make({
        from,
        to,
        cmd: ev.to === "user" ? "task.result" : "ctx.provide",
        scope: scopeForAgent(ev.agent),
        payload: {
          text: ev.text,
          format: ev.format ?? "text",
        },
      })];
    }

    case "unit.handup": {
      return [make({
        from: addressFor(ev.agent, context),
        to: addressFor(ev.parent, context),
        cmd: "task.result",
        scope: scopeForAgent(ev.parent),
        payload: {
          summary: ev.summary,
          artifacts: ev.artifacts,
          facts_to_promote: ev.facts_to_promote,
          decisions: ev.decisions,
          failed_acceptance: ev.failed_acceptance,
          findings: ev.findings,
        },
        refs: ev.artifacts,
      })];
    }

    case "tool.result": {
      return [make({
        from: { id: "system", role: "system" },
        to: addressFor(ev.agent, context),
        cmd: "tool.result",
        scope: scopeForAgent(ev.agent),
        payload: {
          tool_id: ev.id,
          ok: ev.ok,
          output: ev.output.slice(0, 2_000),
        },
      })];
    }

    case "agent.done": {
      const parent = context.getAgent(ev.agent)?.parent;
      return [make({
        from: addressFor(ev.agent, context),
        to: parent ? addressFor(parent, context) : { id: "system", role: "system" },
        cmd: "agent.done",
        scope: scopeForAgent(parent ?? ev.agent),
        payload: {
          success: ev.success,
          reason: ev.reason,
          evidence: ev.evidence,
        },
        refs: ev.evidence ?? [],
      })];
    }

    case "agent.error": {
      const parent = context.getAgent(ev.agent)?.parent;
      return [make({
        from: addressFor(ev.agent, context),
        to: parent ? addressFor(parent, context) : { id: "system", role: "system" },
        cmd: "exception.report",
        priority: "high",
        scope: scopeForAgent(parent ?? ev.agent),
        payload: {
          title: ev.code,
          detail: ev.detail,
          retry_in: ev.retry_in,
          confidence: "confirmed",
        },
      })];
    }

    case "task.notification": {
      return [make({
        from: addressFor(ev.child_id, context),
        to: addressFor(ev.parent, context),
        cmd: ev.success ? "task.result" : "task.fail",
        scope: scopeForAgent(ev.parent),
        payload: {
          success: ev.success,
          reason: ev.reason,
          evidence: ev.evidence,
        },
        refs: ev.evidence ?? [],
      })];
    }

    default:
      return [];
  }
}

function addressFor(agentId: string, context: AgentOSBridgeContext, fallback?: AgentOSRole): AgentOSAddress {
  const info = context.getAgent(agentId);
  return {
    id: agentId,
    role: fallback ?? roleForAgent(info, agentId),
  };
}

function roleForAgent(info: AgentInfo | undefined, agentId: string): AgentOSRole {
  if (agentId === "user") return "user";
  if (agentId === "pm" || agentId.startsWith("feishu-")) return "pm";
  if (!info) return "system";
  if (info.role === "Worker") return "worker";
  if (info.role === "Secretary") return "secretary";
  if (!info.parent || agentId === "pm") return "pm";
  return "leader";
}

function roleForSpawn(role: "Secretary" | "Worker" | "Leader"): AgentOSRole {
  if (role === "Worker") return "worker";
  if (role === "Secretary") return "secretary";
  return "leader";
}

function traceIdForEvent(ev: TuiEvent): string {
  if ("agent" in ev) return `trace-${ev.agent}`;
  if (ev.type === "spawn") return `trace-${ev.parent}`;
  return "trace-system";
}

function taskIdForEvent(ev: TuiEvent): string {
  if ("agent" in ev) return `task-${ev.agent}`;
  if (ev.type === "spawn") return `task-${ev.parent}`;
  return "task-system";
}

function scopeForAgent(agentId: string): string {
  return agentId.startsWith("feishu-") ? "connector:feishu" : "repo:tui-ink";
}
