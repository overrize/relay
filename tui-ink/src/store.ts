import { recordSessionEvent } from "./session/Control.js";
import { observeMemoryEvent } from "./runtime/MemoryEvents.js";
// Store — 单一可变状态。Ink 组件用 useStore() 订阅。
// 手动 subscribe + useState,避免 useSyncExternalStore 与 Ink React 的兼容问题。

import type {
  AgentInfo, Message, TodoItem, TuiEvent, Session, LogLevel,
} from "./protocol.js";
import { AgentOSJournalBridge } from "./runtime/AgentOSJournalBridge.js";
import { recordHealthMetric } from "./runtime/HealthMetrics.js";

interface TokenBucket { prompt: number; completion: number }

interface State {
  agents: Map<string, AgentInfo>;
  selectedAgent: string;          // 当前选中,渲染右栏用
  messagesByAgent: Map<string, Message[]>;
  todosByAgent: Map<string, TodoItem[]>;
  stepByAgent: Map<string, string>;
  pendingApprovals: Message[];    // 待审批的 tool calls
  pendingInputAgents: Set<string>; // agents with queued user messages not yet processed
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  sessionsByAgent: Map<string, Session[]>;
  currentSessionByAgent: Map<string, string>;
  layout: "v1" | "v3";
  scrollOffset: number;
  agentPaneScroll: number;   // manual scroll offset for the left agent panel
  effort: "min" | "mid" | "high" | "max";
  minLevel: LogLevel;
  // Token supervision
  tokensByAgent: Map<string, TokenBucket>;
  sessionTokens: TokenBucket;
  tokenBudget: number;  // 0 = unlimited
  // Human rating request — set after agent.done, cleared after user rates or timeout
  pendingRating: { agentId: string; sessionHash: string } | null;
  feishuConnection: {
    enabled: boolean;
    connected: boolean;
    status: string;
    updatedAt: number | null;
  };
}

const state: State = {
  agents: new Map(),
  selectedAgent: "pm",
  messagesByAgent: new Map(),
  todosByAgent: new Map(),
  stepByAgent: new Map(),
  pendingApprovals: [],
  pendingInputAgents: new Set(),
  cost_usd: 0,
  tokens_in: 0,
  tokens_out: 0,
  sessionsByAgent: new Map(),
  currentSessionByAgent: new Map(),
  layout: "v1",
  scrollOffset: 0,
  agentPaneScroll: 0,
  effort: "mid",
  minLevel: "info",
  tokensByAgent: new Map(),
  sessionTokens: { prompt: 0, completion: 0 },
  tokenBudget: 0,
  pendingRating: null,
  feishuConnection: {
    enabled: false,
    connected: false,
    status: "未连接",
    updatedAt: null,
  },
};

const listeners = new Set<() => void>();
const agentOSJournalBridge = new AgentOSJournalBridge();
let _notifyPending = false;
const notify = () => {
  if (_notifyPending) return;
  _notifyPending = true;
  setImmediate(() => {
    _notifyPending = false;
    listeners.forEach((l) => l());
  });
};

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 在非 React 上下文(事件回调、命令分派)读取当前状态。 */
export function getState(): State { return state; }


let mid = 0;
const newMid = () => `m${++mid}`;

function pushMessage(agent: string, m: Omit<Message, "id" | "ts">) {
  const list = state.messagesByAgent.get(agent) ?? [];
  list.push({ id: newMid(), ts: Date.now(), ...m });
  state.messagesByAgent.set(agent, list);
}

export function ensureAgent(a: AgentInfo) {
  const existing = state.agents.get(a.id);
  state.agents.set(a.id, { ...existing, ...a });
  if (!state.messagesByAgent.has(a.id)) state.messagesByAgent.set(a.id, []);
  if (!state.todosByAgent.has(a.id)) state.todosByAgent.set(a.id, []);
  if (!state.sessionsByAgent.has(a.id)) newSession(a.id);
  notify();
}

export function selectAgent(id: string) {
  if (state.agents.has(id)) { state.selectedAgent = id; state.scrollOffset = 0; notify(); }
}

function visibleAgentRows(): Array<string | "divider"> {
  const nonHidden = Array.from(state.agents.values()).filter((a) => !a.hidden);
  const activeAgents = nonHidden.filter((a) => a.state !== "done" && a.state !== "err");
  const doneAgents = nonHidden.filter((a) => a.state === "done" || a.state === "err");
  return [
    ...activeAgents.map((a) => a.id),
    ...(doneAgents.length > 0 ? ["divider" as const, ...doneAgents.map((a) => a.id)] : []),
  ];
}

export function selectAgentVisible(id: string, maxVisible: number): void {
  if (!state.agents.has(id)) return;
  state.selectedAgent = id;
  state.scrollOffset = 0;

  const rows = visibleAgentRows();
  const idx = rows.indexOf(id);
  if (idx >= 0) {
    const lastVisible = state.agentPaneScroll + Math.max(1, maxVisible) - 1;
    if (idx < state.agentPaneScroll) state.agentPaneScroll = idx;
    else if (idx > lastVisible) state.agentPaneScroll = idx - Math.max(1, maxVisible) + 1;
    state.agentPaneScroll = Math.max(0, Math.min(state.agentPaneScroll, Math.max(0, rows.length - maxVisible)));
  }
  notify();
}

export function userMessage(toAgent: string, text: string) {
  pushMessage(toAgent, { agent: "user", to: toAgent, kind: "text", text });
  notify();
}

/** Mark that a user message is queued but the agent hasn't started processing it yet. */
export function markPendingInput(agentId: string): void {
  state.pendingInputAgents.add(agentId);
  notify();
}

export function clearPendingInput(agentId: string): void {
  state.pendingInputAgents.delete(agentId);
  notify();
}

export function abortAgent(agentId: string): void {
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.agent !== agentId);
  notify();
}

export function approve(toolId: string) {
  const m = state.pendingApprovals.find((p) => p.tool_id === toolId);
  if (m) m.approved = true;
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.tool_id !== toolId);
  notify();
}

export function reject(toolId: string) {
  state.pendingApprovals = state.pendingApprovals.filter((p) => p.tool_id !== toolId);
  notify();
}

export function newSession(agentId: string): string {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const sessions = state.sessionsByAgent.get(agentId) ?? [];
  const session: Session = {
    id,
    agentId,
    title: "(new session)",
    createdAt: Date.now(),
    messageCount: 0,
  };
  sessions.push(session);
  state.sessionsByAgent.set(agentId, sessions);
  state.currentSessionByAgent.set(agentId, id);
  notify();
  return id;
}

export function switchSession(agentId: string, sessionId: string): void {
  const sessions = state.sessionsByAgent.get(agentId) ?? [];
  if (sessions.find((s) => s.id === sessionId)) {
    state.currentSessionByAgent.set(agentId, sessionId);
    notify();
  }
}

export function setLayout(l: "v1" | "v3"): void {
  state.layout = l;
  notify();
}

export function setEffort(e: "min" | "mid" | "high" | "max"): void {
  state.effort = e;
  notify();
}

export function setTokenBudget(n: number): void {
  state.tokenBudget = Math.max(0, n);
  notify();
}

export function setFeishuConnection(patch: Partial<State["feishuConnection"]>): void {
  state.feishuConnection = {
    ...state.feishuConnection,
    ...patch,
    updatedAt: Date.now(),
  };
  notify();
}

/** Returns { prompt, completion, total } for the current session. */
export function getSessionTokens(): { prompt: number; completion: number; total: number } {
  return {
    prompt: state.sessionTokens.prompt,
    completion: state.sessionTokens.completion,
    total: state.sessionTokens.prompt + state.sessionTokens.completion,
  };
}

export function setMinLevel(l: LogLevel): void {
  state.minLevel = l;
  notify();
}

const PERMANENT_IDS = new Set(["pm", "process-monitor"]);

/** Called when user sends next message to PM — hides all completed (done) non-permanent agents. */
export function clearDoneAgents(): void {
  let changed = false;
  for (const [, agent] of state.agents) {
    if (agent.state === "done" && !PERMANENT_IDS.has(agent.id) && !agent.hidden) {
      agent.hidden = true;
      changed = true;
      if (state.selectedAgent === agent.id) {
        state.selectedAgent = agent.parent ?? "pm";
        state.scrollOffset = 0;
      }
    }
  }
  if (changed) notify();
}

export function resumeAgent(id: string): void {
  const a = state.agents.get(id);
  if (!a) return;
  a.state = "run";
  a.sub = "resuming…";
  state.stepByAgent.set(id, "");
  notify();
}

export function updateAgentInfo(id: string, patch: Partial<AgentInfo>): void {
  const info = state.agents.get(id);
  if (!info) return;
  Object.assign(info, patch);
  notify();
}

export function applyEvent(e: TuiEvent) {
  if (!recordSessionEvent(e)) return;
  observeMemoryEvent(e);
  try {
    agentOSJournalBridge.observe(e, {
      getAgent: (agentId) => state.agents.get(agentId),
    });
  } catch (err) {
    process.stderr.write(`[AgentOSJournalBridge] observe failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  switch (e.type) {
    case "agent.state": {
      const a = state.agents.get(e.agent);
      if (a) {
        // Never regress from a terminal state: agent.state:idle is emitted by HttpConvAgent
        // as the stream closes, AFTER agent.done has already set state to "done"/"err".
        // Allowing the overwrite would make children appear active and trigger false
        // "waiting for children" loops and message suppression in the parent.
        if (a.state !== "done" && a.state !== "err") {
          a.state = e.state;
        }
        if (e.sub !== undefined) a.sub = e.sub;
        else if (e.state === "idle" || e.state === "done" || e.state === "err") a.sub = "";
      }
      // Clear pending-input flag: run = agent started processing; err/done = no more processing
      if (e.state === "run" || e.state === "err" || e.state === "done") {
        state.pendingInputAgents.delete(e.agent);
      }
      break;
    }
    case "todo.set":
      state.todosByAgent.set(e.agent, e.items);
      break;
    case "step":
      state.stepByAgent.set(e.agent, e.text);
      break;
    case "message":
      if (e.to === "user") {
        pushMessage(e.agent, { agent: e.agent, to: "user", kind: "text", text: e.text, level: "info" });
      } else {
        pushMessage(e.agent, { agent: e.agent, to: e.to, kind: "text", text: `→ @${e.to}: ${e.text}`, level: "info" });
        pushMessage(e.to,    { agent: e.agent, to: e.to, kind: "text", text: `← @${e.agent}: ${e.text}`, level: "info" });
      }
      // 自动更新当前 session 的标题和计数
      {
        const sessId = state.currentSessionByAgent.get(e.agent);
        if (sessId) {
          const sessions = state.sessionsByAgent.get(e.agent) ?? [];
          const sess = sessions.find((s) => s.id === sessId);
          if (sess) {
            sess.messageCount++;
            if (sess.title === "(new session)" && e.to === "user") {
              sess.title = e.text.slice(0, 40);
            }
          }
        }
      }
      break;
    case "tool.call": {
      const m: Message = {
        id: newMid(), ts: Date.now(),
        agent: e.agent, to: "user", kind: "tool_call",
        text: `${e.name}(${shortArgs(e.args)})`,
        tool_name: e.name, tool_args: e.args, tool_id: e.id, session_revision: e.session_revision,
        needs_approval: !!e.needs_approval, approved: !e.needs_approval,
        level: e.needs_approval ? "warn" : "debug",
      };
      const list = state.messagesByAgent.get(e.agent) ?? [];
      list.push(m);
      state.messagesByAgent.set(e.agent, list);
      if (e.needs_approval) state.pendingApprovals.push(m);
      break;
    }
    case "tool.result":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "tool_result",
        text: `→ ${e.ok ? "✓" : "✗"} ${e.output.slice(0, 160)}`,
        tool_id: e.id,
        level: e.ok ? "debug" : "error",
      });
      break;
    case "spawn": {
      ensureAgent({
        id: e.child, name: e.child, role: e.role,
        parent: e.parent, state: "idle", goal: e.goal, sub: e.goal, model: e.model,
        dispatch: e.dispatch,
      });
      pushMessage(e.parent, {
        agent: e.parent, to: "user", kind: "system",
        text: `⑂ spawn ${e.child} (${e.role}) — ${e.goal}`,
        level: "info",
      });
      // Auto-focus the new child only if currently focused on parent
      if (state.selectedAgent === e.parent) {
        state.selectedAgent = e.child;
        state.scrollOffset = 0;
      }
      break;
    }
    case "agent.done": {
      const a = state.agents.get(e.agent);
      if (a) a.state = e.success ? "done" : "err";
      recordHealthMetric({
        agent_id: e.agent,
        event_type: e.success ? "trace_completed" : "trace_failed",
        severity: e.success ? "info" : "error",
        reason: e.reason ?? (e.success ? "agent_done_success" : "agent_done_failed"),
        meta: {
          parent: a?.parent,
          goal: a?.goal,
        },
      });
      state.stepByAgent.set(e.agent, e.reason ?? (e.success ? "done" : "failed"));
      state.pendingInputAgents.delete(e.agent);
      // Switch back to parent so the user sees PM's follow-up reply
      if (state.selectedAgent === e.agent && a?.parent) {
        state.selectedAgent = a.parent;
        state.scrollOffset = 0;
      }
      break;
    }
    case "agent.error": {
      const a = state.agents.get(e.agent);
      if (a) { a.state = "err"; a.sub = e.detail ?? e.code; }
      state.pendingInputAgents.delete(e.agent);
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `⚠ ${e.code}${e.detail ? ": " + e.detail : ""}`,
        level: "error",
      });
      break;
    }
    case "task.notification": {
      // Notify parent agent that a child has completed (foreground or background mode)
      const status = e.success ? "成功完成" : "失败";
      pushMessage(e.parent, {
        agent: e.child_id, to: "user", kind: "system",
        text: `[系统-通知] 子 agent ${e.child_id} ${status}。理由: ${e.reason ?? "（无）"}`,
        level: e.success ? "info" : "warn",
      });
      // Update child state in todo (mark done)
      const childAgent = state.agents.get(e.child_id);
      if (childAgent) {
        childAgent.state = e.success ? "done" : "err";
        childAgent.sub = e.reason ?? (e.success ? "done" : "failed");
      }
      break;
    }
    // S6: new event types
    case "pm.alert":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `PM[${e.severity}] ${e.code}: ${e.detail}`,
        level: e.severity === "error" ? "error" : "warn",
      });
      break;
    case "unit.handup":
      pushMessage(e.parent, {
        agent: e.agent, to: "user", kind: "system",
        text: `↑ handup from ${e.agent}: ${e.summary.slice(0, 120)}`,
        level: "info",
      });
      break;
    case "decision.record":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `🧭 decision: ${e.decision}${e.reason ? ` — ${e.reason}` : ""}`,
        level: "debug",
      });
      break;
    case "memory.snapshot":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `💾 memory snapshot → ${e.path} (${e.size_kb}kb)`,
        level: "debug",
      });
      break;
    case "shutdown.start":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `⏹ shutdown: ${e.reason}`,
        level: "info",
      });
      break;
    case "proposal.new":
      pushMessage(e.agent, {
        agent: e.agent, to: "user", kind: "system",
        text: `📝 proposal ${e.proposal_id} (${e.target})`,
        level: "info",
      });
      break;
    case "proposal.decision":
      // no agent field — add to leader conv
      pushMessage("leader", {
        agent: "leader", to: "user", kind: "system",
        text: `🗳 proposal ${e.proposal_id}: ${e.decision}${e.reason ? " — " + e.reason : ""}`,
        level: "info",
      });
      break;
    case "token.usage": {
      const existing = state.tokensByAgent.get(e.agent) ?? { prompt: 0, completion: 0 };
      state.tokensByAgent.set(e.agent, {
        prompt: existing.prompt + e.prompt,
        completion: existing.completion + e.completion,
      });
      state.sessionTokens.prompt += e.prompt;
      state.sessionTokens.completion += e.completion;
      // Budget warning: push a system message once when crossing 80% and 95%
      if (state.tokenBudget > 0) {
        const total = state.sessionTokens.prompt + state.sessionTokens.completion;
        const pct = total / state.tokenBudget;
        if (pct >= 0.95 && total - e.prompt - e.completion < state.tokenBudget * 0.95) {
          pushMessage("pm", { agent: "pm", to: "user", kind: "system",
            text: `⚠️ TOKEN 预算已用 ${Math.round(pct * 100)}% — 接近上限！`, level: "error" });
        } else if (pct >= 0.80 && total - e.prompt - e.completion < state.tokenBudget * 0.80) {
          pushMessage("pm", { agent: "pm", to: "user", kind: "system",
            text: `⚠️ TOKEN 预算已用 ${Math.round(pct * 100)}%`, level: "warn" });
        }
      }
      break;
    }
    case "task.notification": {
      const status = e.success ? "成功" : "失败";
      const reason = e.reason ? `。理由: ${e.reason}` : "";
      pushMessage(e.parent, {
        agent: e.agent,
        to: e.parent,
        kind: "system",
        text: `[系统-通知] 子 agent ${e.child_id} ${status}${reason}`,
        level: "info",
      });
      break;
    }
  }
  notify();
}

export const CONV_PAGE = 12;

export function scrollBy(delta: number): void {
  // Upper clamp is handled by ConvPane (it knows total line count).
  // Here just prevent negative so ] at bottom doesn't go past 0.
  state.scrollOffset = Math.max(0, state.scrollOffset + delta);
  notify();
}

/** Clamp the stored scroll offset to a max the renderer knows (content-aware).
 *  Prevents scrollOffset from drifting past the top: without this, scrolling up
 *  past the oldest line keeps inflating the offset, so scrolling back down has to
 *  unwind the excess before it responds. */
export function setScrollOffset(n: number): void {
  const clamped = Math.max(0, n);
  if (clamped !== state.scrollOffset) { state.scrollOffset = clamped; notify(); }
}

export function scrollAgentBy(delta: number, totalAgents: number, maxVisible: number): void {
  const max = Math.max(0, totalAgents - maxVisible);
  state.agentPaneScroll = Math.max(0, Math.min(max, state.agentPaneScroll + delta));
  notify();
}

/** Hide all completed/errored non-permanent agents from the panel. */
/**
 * Collect all descendant agent ids for a given root (BFS).
 * The root itself is included. PERMANENT_IDS are always excluded.
 */
function collectSubtree(rootId: string): string[] {
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (PERMANENT_IDS.has(id)) continue;
    result.push(id);
    for (const [, a] of state.agents) {
      if (a.parent === id) queue.push(a.id);
    }
  }
  return result;
}

/**
 * Hide agents from the panel.
 * - No args → hide all done/err non-permanent agents.
 * - targetId  → hide that agent + all its descendants (any state), PM-immune.
 */
export function pruneAgents(targetId?: string): number {
  const ids = targetId ? collectSubtree(targetId) : null;
  let count = 0;
  for (const [, agent] of state.agents) {
    if (PERMANENT_IDS.has(agent.id) || agent.hidden) continue;
    const shouldHide = ids
      ? ids.includes(agent.id)                              // targeted: any state
      : (agent.state === "done" || agent.state === "err");  // global: done/err only
    if (!shouldHide) continue;
    agent.hidden = true;
    count++;
    if (state.selectedAgent === agent.id) {
      state.selectedAgent = agent.parent ?? "pm";
      state.scrollOffset = 0;
    }
  }
  state.agentPaneScroll = 0;
  if (count > 0) notify();
  return count;
}

function shortArgs(args: unknown): string {
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  } catch { return ""; }
}

/** Remove specified agents from the store without touching anything else. */
export function _deleteAgents(agentIds: string[]): void {
  for (const id of agentIds) {
    state.agents.delete(id);
    state.messagesByAgent.delete(id);
    state.todosByAgent.delete(id);
    state.stepByAgent.delete(id);
    state.tokensByAgent.delete(id);
    state.sessionsByAgent.delete(id);
    state.currentSessionByAgent.delete(id);
  }
}

/** Remove specified agents and reset session token counters (used by E2ESuite phases). */
export function _resetAgents(agentIds: string[]): void {
  _deleteAgents(agentIds);
  state.sessionTokens = { prompt: 0, completion: 0 };
}

export function setPendingRating(agentId: string, sessionHash: string): void {
  state.pendingRating = { agentId, sessionHash };
  notify();
}

export function clearPendingRating(): void {
  state.pendingRating = null;
  notify();
}

export function _resetForTest(): void {
  state.agents.clear();
  state.selectedAgent = "pm";
  state.messagesByAgent.clear();
  state.todosByAgent.clear();
  state.stepByAgent.clear();
  state.pendingApprovals.length = 0;
  state.pendingInputAgents.clear();
  state.cost_usd = 0;
  state.tokens_in = 0;
  state.tokens_out = 0;
  state.sessionsByAgent.clear();
  state.currentSessionByAgent.clear();
  state.layout = "v1";
  state.scrollOffset = 0;
  state.agentPaneScroll = 0;
  state.effort = "mid";
  state.minLevel = "info";
  state.tokensByAgent.clear();
  state.sessionTokens = { prompt: 0, completion: 0 };
  state.tokenBudget = 0;
  state.pendingRating = null;
  state.feishuConnection = {
    enabled: false,
    connected: false,
    status: "未连接",
    updatedAt: null,
  };
}
