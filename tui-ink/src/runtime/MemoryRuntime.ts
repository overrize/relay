/**
 * MemoryRuntime — façade for secretary lifecycle + resume-context injection
 * (spawn-1.0 M1-6c). Owns the closure-free memory glue: secretary create/destroy
 * and the RESUMED CONTEXT block. Per-event `secretary.observe(...)` forwarding stays
 * inline in the handlers and moves in 6e — see docs/spawn-1.0/M1-6c-SPEC.md §2.
 */

import { registerMemoryObserver } from "./MemoryEvents.js";
import { clipTokens } from "../context/budget.js";
import { estimateTokens } from "../context/tokens.js";
import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { createMemory, loadMemory } from "../memory/MemoryStore.js";
import { retrieveRelevant } from "../memory/retrieval.js";
import { logDiag, recordHealthMetric } from "./ObservabilityRuntime.js";

export { SecretaryProxy, factSimilarity, factTokens } from "../memory/SecretaryProxy.js";
export {
  createMemory,
  deleteAgentMemory,
  listUnfinishedAgents,
  loadMemory,
  loadMemoryByHash,
  loadSessions,
  topFactsByWeight,
} from "../memory/MemoryStore.js";

type CreateMemoryParams = Parameters<typeof createMemory>[0];

/**
 * Load-or-create the memory for an agent and register a SecretaryProxy for it.
 * `makeParams` is a thunk so createMemory params aren't built when resuming.
 */
export function initSecretary(
  secretaries: Map<string, SecretaryProxy>,
  id: string,
  resumedMemoryId: string | undefined,
  makeParams: () => CreateMemoryParams,
): SecretaryProxy {
  secretaries.get(id)?.destroy();
  const existingMem = resumedMemoryId ? loadMemory(id) : null;
  const mem = existingMem ?? createMemory(makeParams());
  const sec = new SecretaryProxy(mem, { startNewSession: !existingMem });
  secretaries.set(id, sec);
  const unregister = registerMemoryObserver(id, (event) => sec.observe(event));
  sec.once("destroy", unregister);
  return sec;
}

/** Tear down and unregister an agent's secretary. */
export function destroySecretary(secretaries: Map<string, SecretaryProxy>, id: string): void {
  secretaries.get(id)?.destroy();
  secretaries.delete(id);
}

/**
 * Build the "RESUMED CONTEXT" system-prompt segment for a resuming agent. Returns
 * the string to append to the prompt template (or "" when there's nothing to inject,
 * recording a `resume_context_missing` metric in that case). Extracted verbatim from
 * buildSystemPrompt's resume block.
 */
export function buildResumeContext(
  resumedMemoryId: string,
  agentId: string,
  role: string,
  goal: string | undefined,
): string {
  const mem = loadMemory(resumedMemoryId);
  if (!mem) {
    logDiag(`[resume] WARN: loadMemory("${resumedMemoryId}") returned null — no context injected\n`);
    recordHealthMetric({
      agent_id: agentId,
      event_type: "resume_context_missing",
      severity: "warn",
      reason: `loadMemory("${resumedMemoryId}") returned null`,
      meta: {
        resumedMemoryId,
        role,
        goal: goal?.slice(0, 300),
      },
    });
    return "";
  }

  const configured = mem.dispatch?.memory_quota_kb ?? 60;
  const budgetKb = Number.isFinite(configured) ? Math.max(1, configured) : 60;
  const maxBytes = Math.floor(budgetKb * 1024);
  const maxTokens = Math.min(6000, Math.floor(budgetKb * 256));
  const relevant = retrieveRelevant(resumedMemoryId, mem.working_set.facts, goal ?? "", 10);
  let todo = "(unknown)";
  try {
    if (mem.tombstone.last_todo) todo = JSON.parse(mem.tombstone.last_todo)
      .map((t: { state: string; text: string }) => `[${t.state}] ${t.text}`).join("\n");
  } catch { todo = "(invalid snapshot; inspect persisted history)"; }
  const pending = (mem.tombstone.pending_tool_calls ?? []).map((t) =>
    `- ${t.name}${t.needs_approval ? " (approval pending)" : ""} [id=${t.id}] args=${JSON.stringify(t.args ?? {})}`
  ).join("\n");
  const sections = [
    `\n\n## ⚠️ RESUMED CONTEXT\nResume budget: ${budgetKb}KB\n` +
      `先核对中断操作的实际副作用，不盲目重做。第一句必须输出 todo.set 重申计划。\n`,
    `**中断时未完成的操作（pending）：**\n${pending || "(none)"}\n`,
    `**约束：**\n${mem.dispatch.constraints.join("\n")}\n`,
    `**上次 TODO 状态：**\n${todo}\n`,
    `**关键决定（保留冲突，按时间核对）：**\n${mem.working_set.decisions.slice(-30).map((d) => `- ${d.text}`).join("\n")}\n`,
    `**记录的事实片段（不代表独立验证）：**\n${relevant.map((f) => `- [w${f.weight ?? 1}] ${f.text}`).join("\n")}\n`,
    `**恢复线索：** ${mem.tombstone.resume_hint ?? mem.tombstone.compact_summary ?? "未知"}`,
  ];
  let result = clipTokens(sections.join("\n"), maxTokens);
  if (Buffer.byteLength(result, "utf8") > maxBytes) {
    let lo = 0, hi = result.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(result.slice(0, mid) + "\n[truncated]", "utf8") <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    result = result.slice(0, lo) + "\n[truncated]";
  }
  logDiag(`[resume] context injected: facts=${relevant.length}, decisions=${mem.working_set.decisions.length}, tokens=${estimateTokens(result)}\n`);
  return result;
}
