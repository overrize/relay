// Memory Schema — 每个 agent 一个文件 .spawn/memory/<agent_id>.json

export interface MemoryFact {
  id: string;
  text: string;
  src: string;  // "tool:<name>", "btw:user", "todo:done", "handup:<agentId>"
  ts: number;
  weight?: number;  // cumulative weight for Jaccard-weighted dedup (P1)
}

export interface MemoryDecision {
  id: string;
  text: string;
  rationale: string;
  ts: number;
}

export interface MemoryQuestion {
  id: string;
  text: string;
  blocking: boolean;
}

export interface ChildHandle {
  agent_id: string;
  status: "running" | "done" | "error";
  goal: string;
  handup: unknown | null;
}

export interface Tombstone {
  compact_summary: string | null;
  final_status: "done" | "error" | "interrupted" | null;
  final_artifacts: string[];
  resume_hint: string | null;
  last_todo?: string;  // JSON serialized last todo.set items
  /** M1-8: tool.calls in flight (no tool.result yet) when the agent was interrupted.
   *  Injected on resume so the "现场" (pending work / approvals) is restored, not just memory. */
  pending_tool_calls?: Array<{ id: string; name: string; args?: unknown; needs_approval?: boolean }>;
  /** Bus log offset at last Secretary flush — replay log from here to reconstruct state delta. */
  log_cursor?: number;
  /** Bus epoch at flush time — if mismatched on load, the cursor is from a dead process and must be discarded. */
  log_cursor_epoch?: string;
}

export interface AgentMemory {
  schema_version: 1;
  agent_id: string;
  agent_type: "PM" | "LEADER" | "SECRETARY" | "WORKER";
  session_hash?: string;  // 7-char hex for /resume <hash>
  parent_chain: string[];
  depth: number;
  created_at: number;
  updated_at: number;
  identity: {
    role_name: string;
    skills: string[];
    model: string;
  };
  dispatch: {
    background: string;
    constraints: string[];
    acceptance_criteria: string[];
    stop_conditions: string[];
    memory_quota_kb?: number;  // soft budget in KB for resume context (P1, default 60)
  };
  working_set: {
    facts: MemoryFact[];
    decisions: MemoryDecision[];
    open_questions: MemoryQuestion[];
  };
  child_handles: ChildHandle[];
  tombstone: Tombstone;
}
