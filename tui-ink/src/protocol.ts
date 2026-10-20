// 协议类型 — 这就是 TUI 和 agent 之间的全部词汇。
// 见 docs/AGENTS.md §3.

export type AgentRunState = "idle" | "run" | "wait" | "done" | "warn" | "err";
export type TodoState = "todo" | "run" | "done" | "warn" | "err";

// S1: DispatchSpec — 每次 spawn 必须携带，Leader 在 spawn 前验证
export interface DispatchSpec {
  worker_profile?: "implement" | "research" | "review" | "verify";
  recovery?: { mode?: "auto" | "manual"; max_attempts?: number; max_turns?: number; max_requests?: number; max_tools?: number; total_ms?: number };
  acceptance_checks?: Array<{ criterion: number; type: "file_contains" | "file_sha256" | "test_suite"; path: string; value?: string }>;
  background: string;                  // 上下文背景（必填）
  constraints: string[];               // 执行约束
  acceptance_criteria: string[];       // 验收标准（至少 1 条）
  stop_conditions: string[];           // 终止条件（至少 1 条）
  skills?: {
    inherit_default: boolean;
    exclude?: string[];
    request?: string[];
  };
  max_turns?: number;
  memory_quota_kb?: number;
  seed_facts?: string[];
  timeout_ms?: number;                 // 软超时：到期 PM 发 handup 纠正，不立即 kill
  /** Override the worker system-prompt file (e.g. "worker-coding"). Default: "worker". */
  prompt_file?: string;
  // Fork 子 agent 专用字段（与常规 spawn 兼容共存）
  fork?: boolean;                      // true = 走 Fork 路径（轻量分身，共享缓存前缀）
  cachePrefix?: CacheSafeParams;        // 父 agent 的缓存前缀（Fork 时必传）
  inheritSystemPrompt?: boolean;        // 是否继承父 agent 的 system prompt（Fork 默认为 true）
  parentMessageIndex?: number;          // Fork 时对话历史截止索引
}

import type { CacheSafeParams } from "./cache/CachePrefixManager.js";
export type { CacheSafeParams };

export interface TodoItem {
  id: string;
  state: TodoState;
  text: string;
  progress?: number; // 0..100
  started_at?: number;
  eta?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  role: "Leader" | "Secretary" | "Worker";
  parent?: string;
  state: AgentRunState;
  goal?: string; // spawn 时的原始 goal，不可变
  sub?: string;  // 一行话当前状态（会随 agent.state 事件更新）
  model?: string;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  dispatch?: DispatchSpec; // S1: spawn 时携带的 DispatchSpec
  depth?: number;          // S3: 在 spawn 树中的深度
  hidden?: boolean;        // true = removed from agent list after successful completion
}

export interface Message {
  id: string;
  agent: string;     // 谁说的 (agent id),或 "user"
  to: string;        // 给谁,通常 "user" 或另一个 agent id
  ts: number;
  kind: "text" | "tool_call" | "tool_result" | "system";
  text: string;
  tool_name?: string;
  tool_args?: unknown;
  tool_id?: string;
  session_revision?: number;
  needs_approval?: boolean;
  approved?: boolean;
  level?: "debug" | "info" | "warn" | "error";
}

// agent → TUI
export type TuiEvent = (
  | { v: 1; type: "todo.set"; agent: string; items: TodoItem[] }
  | { v: 1; type: "step"; agent: string; text: string }
  | {
      v: 1; type: "tool.call"; agent: string; id: string;
      name: string; args: unknown; needs_approval?: boolean;
    }
  | { v: 1; type: "tool.result"; agent: string; id: string; ok: boolean; output: string }
  | { v: 1; type: "message"; agent: string; to: string; text: string; format?: "text" | "document" }
  | {
      v: 1; type: "spawn"; parent: string; child: string;
      role: "Secretary" | "Worker" | "Leader"; goal: string; model?: string;
      dispatch?: DispatchSpec; // S1: full dispatch spec
    }
  | { v: 1; type: "agent.done"; agent: string; success: boolean; reason?: string; evidence?: string[] }
  | { v: 1; type: "agent.error"; agent: string; code: string; detail?: string; retry_in?: number }
  | { v: 1; type: "agent.state"; agent: string; state: AgentRunState; sub?: string }
  // S6: new protocol events
  | { v: 1; type: "unit.handup"; agent: string; parent: string;
      summary: string; artifacts: string[];
      facts_to_promote: string[]; decisions: string[];
      failed_acceptance: string[];
      findings?: Array<{ level: "CRITICAL" | "WARNING" | "INFO"; text: string }> }
  | { v: 1; type: "decision.record"; agent: string; decision: string; reason?: string }
  | { v: 1; type: "memory.snapshot"; agent: string; path: string; size_kb: number }
  | { v: 1; type: "shutdown.start"; agent: string; reason: string }
  | { v: 1; type: "pm.alert"; severity: "warn" | "error";
      code: string; agent: string; detail: string; ts?: number }
  | { v: 1; type: "proposal.new"; agent: string; proposal_id: string;
      target: "role_boundary" | "principles"; diff: string }
  | { v: 1; type: "task.notification"; agent: string; parent: string;
      child_id: string; success: boolean; reason?: string; evidence?: string[] }
  | { v: 1; type: "proposal.decision"; proposal_id: string;
      decision: "apply" | "reject"; reason?: string }
  // leader → TUI: approve/reject a destructive Bash call from a worker
  | { v: 1; type: "tool.approved"; id: string; reason?: string }
  | { v: 1; type: "tool.rejected"; id: string; reason?: string }
  // leader → TUI: kill a child agent (same effect as ESC on that agent's pane)
  | { v: 1; type: "agent.kill"; agent: string; target: string; reason?: string }
  // Token usage — emitted by httpAgent after each LLM turn (not parsed from LLM output)
  | { v: 1; type: "token.usage"; agent: string; prompt: number; completion: number;
      ttft_ms?: number;   // time-to-first-token: request start → first content chunk (ms)
      total_ms?: number;  // total call duration: request start → stream end (ms)
    }) & { session_revision?: number };

// TUI → agent  (写到 agent.stdin)
export type AgentCommand =
  | { type: "user.message"; text: string }
  | { type: "tool.result"; id: string; ok: boolean; output: string }
  | { type: "tool.reject"; id: string; reason: string }
  | { type: "control"; action: "pause" | "resume" | "interrupt" };

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: number;
  messageCount: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
