// ProcessManager — TypeScript 规则引擎
// 订阅全局事件流，执行同步阻断（preCheckSpawn）和异步告警（observe + tick）
// 没有 LLM，没有 sendCommand 能力；只读 + 发 pm.alert

import { orchestrationMode, type OrchestrationMode } from "./mode.js";
import { EventEmitter } from "node:events";
import type { TuiEvent, AgentRunState } from "../protocol.js";
import { getState } from "../store.js";
import { recordHealthMetric, type HealthMetricEventType } from "../runtime/HealthMetrics.js";

// ── Auto-background 支持 ──────────────────────────────────────────────────────
export type SpawnState = "foreground" | "background" | "done" | "none";

export interface ForegroundSpawnHandle {
  childId: string;
  parentId: string;
  startedAt: number;
  mode: SpawnState;  // 'foreground' | 'background'
  /** Promise resolves with child result if completed within 30s, null if switched to background */
  promise: Promise<{ success: boolean; reason?: string; evidence?: string[] } | null>;
  /** Forcefully switch to background (called at 2min timeout or manually) */
  setBackground: () => void;
  /** Resolve the foreground promise (internal) */
  _resolve: (result: { success: boolean; reason?: string; evidence?: string[] } | null) => void;
}

const SYNC_WAIT_MS = 30_000;   // 30s 同步等待阈值
const BG_TIMEOUT_MS = 120_000;  // 2min 后台切换阈值

export interface PMAlert {
  severity: "warn" | "error";
  code: string;
  agent: string;
  detail: string;
  ts: number;
  acked: boolean;
}

interface AgentStats {
  startTime: number;
  pausedMs: number;           // 累计暂停在等待 approval 的毫秒数（不计入 age）
  lastPauseStart: number;     // 本次进入 approval 等待的时刻（0 = 未暂停）
  lastProgressTs: number;     // 最后一次 step / todo.set
  lastSnapshotTs: number;     // 最后一次 memory.snapshot
  toolPathCounter: Map<string, number>;
  recentEventCount: number;
  role?: string;
  noProgressWarnSent: boolean;
  timeoutNudgeSent: boolean;  // dispatch.timeout_ms 软超时纠正只发一次
}

const NO_PROGRESS_MS  = 5 * 60 * 1000;
const LOOP_WINDOW     = 100;
const LOOP_THRESHOLD  = 10;
const MAX_DEPTH       = 4;
const DEFAULT_FANOUT  = 4;

export class ProcessManager extends EventEmitter {
  private stats = new Map<string, AgentStats>();
  private alerts: PMAlert[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private maxFanout = DEFAULT_FANOUT;

  // ── Auto-background tracking ────────────────────────────────────────────────
  /** childAgentId -> ForegroundSpawnHandle */
  private foregroundSpawns = new Map<string, ForegroundSpawnHandle>();
  private foregroundTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Register a new spawn and return a handle that resolves in 30s or switches to bg at 2min. */
  registerSpawn(childId: string, parentId: string): ForegroundSpawnHandle {
    // Cancel any existing foreground promise for this child
    this.cancelForeground(childId);

    let resolve: (r: { success: boolean; reason?: string; evidence?: string[] } | null) => void;
    const promise = new Promise<{ success: boolean; reason?: string; evidence?: string[] } | null>((res) => {
      resolve = res;
    });
    const realResolve = resolve!;

    const handle: ForegroundSpawnHandle = {
      childId,
      parentId,
      startedAt: Date.now(),
      mode: 'foreground',
      promise,
      setBackground: () => {
        handle.mode = 'background';
        realResolve(null);
      },
      _resolve: realResolve,
    };

    this.foregroundSpawns.set(childId, handle);

    // Schedule 2min auto-background transition
    const timer = setTimeout(() => {
      this.foregroundTimers.delete(childId);
      const h = this.foregroundSpawns.get(childId);
      if (h && h.childId === childId && h.mode === 'foreground') {
        h.setBackground();
        this.emit("background", { childId, parentId, reason: "timeout" });
      }
    }, BG_TIMEOUT_MS);
    timer.unref();
    this.foregroundTimers.set(childId, timer);

    return handle;
  }

  /** Complete or cancel a foreground wait (called when child finishes or errors). */
  completeForeground(childId: string, result: { success: boolean; reason?: string; evidence?: string[] } | null): void {
    clearTimeout(this.foregroundTimers.get(childId));
    this.foregroundTimers.delete(childId);
    const h = this.foregroundSpawns.get(childId);
    if (h) {
      if (h.mode === 'foreground') {
        h.mode = 'done';
        h._resolve(result);
      }
      // If mode was 'background', the promise is already resolved (null).
      // Keep handle so isForeground returns 'background', not 'foreground' -> task.notification
    }
  }

  /** Check if a child is still in foreground (not yet timeout/background). */
  isForeground(childId: string): boolean {
    return this.foregroundSpawns.get(childId)?.mode === 'foreground';
  }

  /** Cancel foreground tracking for a child (cleanup). */
  cancelForeground(childId: string): void {
    clearTimeout(this.foregroundTimers.get(childId));
    this.foregroundTimers.delete(childId);
    const h = this.foregroundSpawns.get(childId);
    if (h) {
      h._resolve(null);
      this.foregroundSpawns.delete(childId);
    }
  }

  /** Get child IDs that are still actively blocking the parent (mode === 'foreground' only).
   *  Excludes 'done' (completed) and 'background' (timed-out) handles so that
   *  hasActiveChildren checks don't keep the parent waiting after children finish. */
  getForegroundChildren(parentId: string): string[] {
    return Array.from(this.foregroundSpawns.values())
      .filter((h) => h.parentId === parentId && h.mode === 'foreground')
      .map((h) => h.childId);
  }


  constructor(private mode: OrchestrationMode = orchestrationMode()) {
    super();
    // 每 10s 检查超时类规则
    this.tickTimer = setInterval(() => this.tick(), 10_000);
    this.tickTimer.unref();
  }

  // ── 同步阻断（在 startWorker 入口调用）─────────────────────────────────────

  setFanout(n: number): void {
    this.maxFanout = Math.max(1, Math.min(16, n));
  }

  getMaxFanout(): number { return this.maxFanout; }

  getMode(): OrchestrationMode { return this.mode; }

  preCheckSpawn(
    ev: Extract<TuiEvent, { type: "spawn" }>,
    parentRole: string | undefined,
  ): { ok: true } | { ok: false; code: string; detail: string } {
    const state = getState();
    if (this.mode === "single") return this.reject("single_mode", ev.parent, "Single mode does not create child agents");

    // Worker 不能 spawn
    if (parentRole === "Worker") {
      return this.reject("worker_cannot_spawn", ev.parent,
        `Worker ${ev.parent} 尝试 spawn —— Worker 只能 handup，由 Leader 决定是否二次 spawn`);
    }

    // 深度 0 (PM) 只能 spawn Leader 或 Secretary — 不能直接 spawn Worker
    const parentDepthNow = this.getDepth(ev.parent);
    if (this.mode === "adaptive" && parentDepthNow >= 1 && ev.role === "Leader") return this.reject("adaptive_layer_limit", ev.parent, "Adaptive mode allows one coordinator layer only; dispatch Workers directly or explicitly choose hierarchical mode");
    if (this.mode === "hierarchical" && parentDepthNow === 0 && ev.role === "Worker") {
      return this.reject("pm_cannot_spawn_worker", ev.parent,
        `PM (depth=0) 不能直接 spawn Worker — 先 spawn Tech Lead (role:"Leader")，再由 Tech Lead spawn Worker`);
    }
    // depth ≥ 2 不能 spawn Leader
    if (parentDepthNow >= 2 && ev.role === "Leader") {
      return this.reject("depth_role_violation", ev.parent,
        `depth=${parentDepthNow} 的 agent 不能 spawn Leader（只有 PM 可以）`);
    }

    // dispatch 必须携带且字段完整
    if (!ev.dispatch) {
      return this.reject("dispatch_missing", ev.parent,
        `spawn ${ev.child}: 缺少 dispatch 字段（必须携带 background / acceptance_criteria / stop_conditions）`);
    }
    if (!ev.dispatch.background) {
      return this.reject("dispatch_missing_background", ev.parent,
        `spawn ${ev.child}: dispatch.background 不能为空`);
    }
    if (!ev.dispatch.acceptance_criteria?.length) {
      return this.reject("dispatch_missing_acceptance", ev.parent,
        `spawn ${ev.child}: dispatch.acceptance_criteria 至少需要 1 条`);
    }
    if (!ev.dispatch.stop_conditions?.length) {
      return this.reject("dispatch_missing_stopcond", ev.parent,
        `spawn ${ev.child}: dispatch.stop_conditions 至少需要 1 条`);
    }

    // 深度限制
    const parentDepth = this.getDepth(ev.parent);
    if (parentDepth + 1 > MAX_DEPTH) {
      return this.reject("depth_exceeded", ev.parent,
        `spawn ${ev.child}: 深度 ${parentDepth + 1} 超过最大允许深度 ${MAX_DEPTH}`);
    }

    // 扇出限制（使用可配置的 maxFanout）
    const runningChildren = this.countRunningChildren(ev.parent);
    if (runningChildren >= this.maxFanout) {
      return this.reject("fanout_exceeded", ev.parent,
        `spawn ${ev.child}: ${ev.parent} 已有 ${runningChildren} 个 RUNNING 子节点（上限 ${this.maxFanout}）`);
    }

    // 重复 goal 检测
    if (this.hasRunningChildWithGoal(ev.parent, ev.goal)) {
      return this.reject("duplicate_goal", ev.parent,
        `spawn ${ev.child}: ${ev.parent} 已有 goal="${ev.goal}" 的 RUNNING 子节点`);
    }

    return { ok: true };
  }

  // ── 异步观察（在 applyEvent 之后调用）────────────────────────────────────

  observe(ev: TuiEvent): void {
    const agentId = "agent" in ev ? ev.agent : null;
    if (!agentId) return;

    const stats = this.getOrCreate(agentId);
    stats.recentEventCount++;

    switch (ev.type) {
      case "agent.state":
        if (ev.state === "run" && !stats.startTime) {
          stats.startTime = Date.now();
        }
        break;

      case "step":
      case "todo.set":
        stats.lastProgressTs = Date.now();
        stats.noProgressWarnSent = false;
        break;

      case "tool.call": {
        const toolArgs = ev.args as Record<string, unknown> | null;
        const filePath = String(toolArgs?.path ?? toolArgs?.file_path ?? toolArgs?.pattern ?? "");
        if (filePath) {
          const count = (stats.toolPathCounter.get(filePath) ?? 0) + 1;
          stats.toolPathCounter.set(filePath, count);
          // Cumulative alert: fire at LOOP_THRESHOLD, 2×, 3×... regardless of window size
          // Avoids missing loops whose cycle length exceeds LOOP_WINDOW
          if (count > 0 && count % LOOP_THRESHOLD === 0) {
            this.emitAlert("warn", "loop_suspected", agentId,
              `${agentId} 对 "${filePath}" 累计调用工具 ${count} 次（每 ${LOOP_THRESHOLD} 次告警一次）`);
          }
        }
        break;
      }

      case "memory.snapshot":
        stats.lastSnapshotTs = Date.now();
        break;

      case "agent.done":
        // 30s 内是否有 memory.snapshot
        if (Date.now() - stats.lastSnapshotTs > 30_000 && stats.lastSnapshotTs !== 0) {
          this.emitAlert("error", "memory_not_saved", agentId,
            `${agentId} 完成但 memory.snapshot 超时（最后快照 ${Math.round((Date.now() - stats.lastSnapshotTs) / 1000)}s 前）`);
        }
        this.stats.delete(agentId);
        break;

      case "message":
        // 通信矩阵违规检测
        this.validateMessage(ev as Extract<TuiEvent, { type: "message" }>);
        break;
    }
  }

  // ── 定时检查（每 10s）────────────────────────────────────────────────────

  tick(): void {
    const state = getState();
    const now = Date.now();

    for (const [agentId, stats] of this.stats) {
      const info = state.agents.get(agentId);
      if (!info || info.state !== "run") continue;

      // Track approval-wait windows so they don't count against the timeout.
      const waitingForApproval = state.pendingApprovals.some((p) => p.agent === agentId);
      if (waitingForApproval) {
        if (!stats.lastPauseStart) stats.lastPauseStart = now;
        continue; // skip all time checks while user hasn't responded
      } else if (stats.lastPauseStart) {
        // User just approved/rejected — bank the paused duration
        stats.pausedMs += now - stats.lastPauseStart;
        stats.lastPauseStart = 0;
      }

      if (stats.startTime) {
        // Effective age excludes time spent waiting for user approval
        const age = now - stats.startTime - stats.pausedMs;

        // dispatch.timeout_ms 软超时 — 只发一次 handup 纠正信号
        const dispatchTimeout = info.dispatch?.timeout_ms;
        if (dispatchTimeout && age > dispatchTimeout && !stats.timeoutNudgeSent) {
          stats.timeoutNudgeSent = true;
          this.emitAlert("warn", "dispatch_timeout", agentId,
            `${agentId} 有效运行时间超 dispatch.timeout_ms (${dispatchTimeout}ms)，发送 handup 纠正`);
          this.emit("timeout", agentId);
        }
      }

      if (stats.lastProgressTs && !stats.noProgressWarnSent) {
        const idle = now - stats.lastProgressTs;
        if (idle > NO_PROGRESS_MS) {
          this.emitAlert("warn", "no_progress", agentId,
            `${agentId} 已 ${Math.round(idle / 60000)}min 无 step/todo 进展`);
          stats.noProgressWarnSent = true;
        }
      }

      // orphaned_unit check omitted: Secretary is a TS object, not in state.agents
    }
  }

  // ── 告警管理 ──────────────────────────────────────────────────────────────

  getAlerts(): PMAlert[] { return this.alerts; }
  getUnacked(): PMAlert[] { return this.alerts.filter((a) => !a.acked); }
  ackAlert(code: string): void {
    const a = this.alerts.find((x) => x.code === code && !x.acked);
    if (a) a.acked = true;
  }

  destroy(): void {
    for (const id of this.foregroundSpawns.keys()) this.cancelForeground(id);
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
  }

  // ── private ────────────────────────────────────────────────────────────────

  private reject(
    code: string,
    agent: string,
    detail: string,
  ): { ok: false; code: string; detail: string } {
    this.emitAlert("error", code, agent, detail);
    return { ok: false, code, detail };
  }

  private emitAlert(
    severity: "warn" | "error",
    code: string,
    agent: string,
    detail: string,
  ): void {
    const alert: PMAlert = { severity, code, agent, detail, ts: Date.now(), acked: false };
    this.alerts.push(alert);
    const metricType = metricTypeForAlert(code);
    if (metricType) {
      recordHealthMetric({
        agent_id: agent,
        event_type: metricType,
        severity,
        reason: detail,
        ts: alert.ts,
        meta: { pmAlertCode: code },
      });
    }
    // 最多保留 200 条告警
    if (this.alerts.length > 200) this.alerts = this.alerts.slice(-200);
    this.emit("event", {
      v: 1,
      type: "pm.alert",
      severity,
      code,
      agent,
      detail,
      ts: alert.ts,
    } as TuiEvent);
  }

  private validateMessage(ev: Extract<TuiEvent, { type: "message" }>): void {
    const state = getState();
    const senderRole = state.agents.get(ev.agent)?.role;

    // Worker 不能 message.to=user
    if (senderRole === "Worker" && ev.to === "user") {
      this.emitAlert("warn", "illegal_message", ev.agent,
        `Worker ${ev.agent} 尝试直接 message.to=user（应 message.to=leader）`);
    }

    // Worker 不能 message 给另一个 Worker
    const recipientRole = state.agents.get(ev.to)?.role;
    if (senderRole === "Worker" && recipientRole === "Worker") {
      this.emitAlert("warn", "illegal_message", ev.agent,
        `Worker ${ev.agent} 尝试 message.to=${ev.to}（Worker 间直接通信被禁止）`);
    }
  }

  private getDepth(agentId: string): number {
    const state = getState();
    let depth = 0;
    let current = agentId;
    for (let i = 0; i < 10; i++) {
      const info = state.agents.get(current);
      if (!info?.parent) break;
      depth++;
      current = info.parent;
    }
    return depth;
  }

  private countRunningChildren(agentId: string): number {
    return Array.from(getState().agents.values())
      .filter((a) => a.parent === agentId && a.state === "run")
      .length;
  }

  private hasRunningChildWithGoal(agentId: string, goal: string): boolean {
    // Normalize: trim, lowercase, collapse whitespace, strip punctuation variance
    const norm = (g: string) => g.trim().toLowerCase().replace(/[\s　]+/g, " ");
    const normNew = norm(goal);
    return Array.from(getState().agents.values()).some((a) => {
      if (a.parent !== agentId) return false;
      // Cover both the spawn→start window (idle) and running state
      if (a.state !== "run" && a.state !== "idle") return false;
      if (a.hidden) return false;
      // Use the immutable goal field; fall back to sub only if goal wasn't stored
      const existing = a.goal ?? a.sub ?? "";
      return existing !== "" && norm(existing) === normNew;
    });
  }

  private getOrCreate(agentId: string): AgentStats {
    if (!this.stats.has(agentId)) {
      this.stats.set(agentId, {
        startTime: 0,
        pausedMs: 0,
        lastPauseStart: 0,
        lastProgressTs: Date.now(),
        lastSnapshotTs: 0,
        toolPathCounter: new Map(),
        recentEventCount: 0,
        noProgressWarnSent: false,
        timeoutNudgeSent: false,
      });
    }
    return this.stats.get(agentId)!;
  }
}

export function metricTypeForAlert(code: string): HealthMetricEventType | null {
  switch (code) {
    case "loop_suspected":
      return "tool_call_repeated";
    case "no_progress":
      return "no_progress_nudge";
    case "dispatch_timeout":
      return "dispatch_timeout";
    default:
      return null;
  }
}
