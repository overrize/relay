/**
 * ToolRuntime — façade for tool execution + approver lookup (spawn-1.0 M1-6b).
 * Owns the pure, closure-free pieces of the tool path: the fan-out executor, the
 * base tool-result formatter, and the parent-chain approver lookup. The per-handler
 * reinject choreography (setImmediate / done-guards / coding-guard state) stays inline
 * in the event handlers and moves in 6e — see docs/spawn-1.0/M1-6b-SPEC.md §2.
 */

import type { TuiEvent } from "../protocol.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";
import { executeTool, type ToolResult } from "../tools/registry.js";

export {
  buildToolSchemaBlock,
  executeTool,
  toolNeedsApproval,
} from "../tools/registry.js";
export type { AgentRole, ToolResult } from "../tools/registry.js";

export type ToolCall = Extract<TuiEvent, { type: "tool.call" }>;

/**
 * Execute a batch of tool calls, preserving order. Byte-equivalent to the inline
 * `Promise.all(batch.map((c) => executeTool(c.name, c.args, { agentId, revision: c.session_revision, callId: c.id })))`.
 */
export function runToolBatch(batch: ToolCall[], agentId: string): Promise<ToolResult[]> {
  return Promise.all(batch.map((c) => executeTool(c.name, c.args, { agentId, revision: c.session_revision, callId: c.id })));
}

/**
 * Build the base combined tool-result string fed back to the LLM. Handlers may
 * append circuit-breaker / test-convergence suffixes at the call site (not here).
 */
export function formatToolResults(batch: ToolCall[], results: ToolResult[]): string {
  return batch
    .map((c, i) => `[tool_result id="${c.id}" ok="${results[i]!.ok}"]\n${results[i]!.output}`)
    .join("\n\n");
}

/** Minimal read-only view of store state needed for approver lookup. */
interface ApproverCtx {
  agents: Map<string, HttpConvAgent>;
  getState: () => { agents: Map<string, { parent?: string; role?: string }> };
}

/**
 * Walk up the parent chain to the nearest Leader/PM that can approve a worker's
 * destructive tool. Falls back to the root PM. Pure query — no side effects.
 */
export function findApproverLeader(childId: string, ctx: ApproverCtx): HttpConvAgent | null {
  const { agents, getState } = ctx;
  let cur = childId;
  for (let i = 0; i < 10; i++) {
    const info = getState().agents.get(cur);
    if (!info?.parent) {
      // Reached root without finding a leader parent — PM is the fallback
      const root = agents.get("pm");
      return root instanceof HttpConvAgent ? root : null;
    }
    cur = info.parent;
    const parentAgent = agents.get(cur);
    const parentInfo = getState().agents.get(cur);
    if (parentAgent instanceof HttpConvAgent &&
        (parentInfo?.role === "Leader" || cur === "pm")) {
      return parentAgent;
    }
  }
  return null;
}
