import * as path from 'node:path';
import type {TuiEvent} from '../protocol.js';
import * as fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {config as dotenvConfig} from 'dotenv';
import {HttpConvAgent} from '../adapters/httpAgent.js';
import {loadConfig,getAgentProviderConfig} from '../config.js';
import {createRuntimeContext} from './RuntimeContext.js';
import {configureAgentHandlers,startLeaderAgent} from './AgentHandlers.js';
import {configureFeishuBridge,feishuForks} from './FeishuBridge.js';
import {buildToolSchemaBlock,type AgentRole} from './ToolRuntime.js';
import {getState,applyEvent,abortAgent} from '../store.js';
import {globalBus} from '../bus/Bus.js';
import {recordTaskCancellation,stopTaskRecovery,waitTaskResolution} from './TaskRecovery.js';
import {cancelAllAgentTools} from '../tools/command.js';
import {waitForIndexing} from '../session/SearchIndex.js';
import {releaseRuntimeOwners} from '../session/RuntimeOwner.js';
dotenvConfig({quiet:true});
// ── 路径 ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const argv = process.argv.slice(2);
export const flag = (k: string) => argv.find((a) => a.startsWith(`--${k}`));
export const DEMO = !!flag("demo");
const requestedMode = flag("mode")?.split("=")[1];
if (requestedMode) process.env.SPAWN_ORCHESTRATION = requestedMode;
export const MODEL = flag("model")?.split("=")[1] ?? "claude-sonnet-4-5";
export const PROMPTS_DIR = path.resolve(__dirname, "..", "..",
  flag("prompts")?.split("=")[1] ?? "../prompts");


// ── 拼系统 prompt ──────────────────────────────────────────────────────────
export function buildSystemPrompt(
  role: "Leader" | "Secretary" | "Worker",
  agentId: string,
  goal?: string,
  resumedMemoryId?: string,
  promptFile?: string, // override default: "pm", "leader", "worker", etc.
): string {
  const base = readIfExists(path.join(PROMPTS_DIR, "_base.md"));
  const requestedPrompt = promptFile ?? role.toLowerCase();
  const actualPrompt = requestedPrompt === "pm" && pm.getMode() !== "hierarchical" ? "pm-adaptive" : requestedPrompt;
  const rolePrompt = readIfExists(path.join(PROMPTS_DIR, `${actualPrompt}.md`));
  let tpl = `${base}\n\n---\n\n${rolePrompt}`;

  // S3: inject RESUMED CONTEXT when resuming from memory (6c → MemoryRuntime)
  // Live, fork and resumed requests use the same session context compiler.

  const cfg = loadConfig();
  const leaderCfg = getAgentProviderConfig(cfg, "leader");
  const workerCfg = getAgentProviderConfig(cfg, "worker");
  const secretaryCfg = getAgentProviderConfig(cfg, "secretary");
  return tpl
    .replace(/\{\{ORCHESTRATION_MODE\}\}/g, pm.getMode())
    .replace(/\{\{AGENT_ID\}\}/g, agentId)
    .replace(/\{\{ROLE\}\}/g, role)
    .replace(/\{\{GOAL\}\}/g, goal ?? "(无，等用户指令)")
    .replace(/\{\{ALLOWED_TOOLS\}\}/g, buildToolSchemaBlock(role as AgentRole))
    .replace(/\{\{PARENT_ID\}\}/g, "—")
    .replace(/\{\{CWD\}\}/g, process.cwd())
    .replace(/\{\{AGENT_LIST\}\}/g, Array.from(agents.keys()).join(", ") || "(仅你自己)")
    .replace(/\{\{WORKER_MODEL\}\}/g, workerCfg.model)
    .replace(/\{\{LEADER_MODEL\}\}/g, leaderCfg.model)
    .replace(/\{\{SECRETARY_MODEL\}\}/g, secretaryCfg.model);
}
function readIfExists(p: string): string {
  try { return fs.readFileSync(p, "utf8"); } catch { return `(missing: ${p})`; }
}

// ── 全局单例 ───────────────────────────────────────────────────────────────
export const runtimeContext = createRuntimeContext();
export const { agents, secretaries, pm, scheduledTasks, killedAgents, feishuBusy, pmPendingArtifacts, leaderApprovalQueue } = runtimeContext;
// 6e: inject runtime deps into FeishuBridge (startLeaderAgent is hoisted, safe to reference).
configureFeishuBridge({ agents, feishuBusy, killedAgents, pm, pmPendingArtifacts, startLeaderAgent });
// 6e: inject runtime deps into AgentHandlers (buildSystemPrompt/killAgent are hoisted).
configureAgentHandlers({ agents, killedAgents, pm, feishuBusy, secretaries, pmPendingArtifacts, leaderApprovalQueue, buildSystemPrompt, killAgent, MODEL, DEMO });
// Feishu-only module state moved to FeishuBridge.ts (6e).

// Agents that were explicitly killed by the user (ESC) or by a parent agent.kill event.
// Used to suppress child→parent notifications after a kill so the parent isn't restarted.

// Artifact files reported by TL children (message.to=parent or unit.handup) that PM
// must inject as full document content before its next onTurnEnd flush.
// Keyed by PM agent ID; values are absolute file paths to read.

// Destructive Bash commands from workers are routed to leader for approval instead
// of asking the user directly. Keyed by tool.call id.
// PM 事件转发到 TUI
pm.on("event", (ev: TuiEvent) => applyEvent(ev));
pm.on("kill", (agentId: string) => {
  agents.get(agentId)?.kill?.();
  applyEvent({ v: 1, type: "agent.error", agent: agentId, code: "runtime_exceeded", detail: "PM killed: exceeded 60min hard limit" });
});

// dispatch.timeout_ms 软超时：PM 发纠正让 Worker 主动 handup，不直接 kill
pm.on("timeout", (agentId: string) => {
  const worker = agents.get(agentId);
  if (worker instanceof HttpConvAgent) {
    worker.sendCommand({
      type: "user.message",
      text: `[系统-超时] 你的 dispatch.timeout_ms 已到期。立刻输出 unit.handup（说明已完成的工作和未完成原因），然后 agent.done(success:false, reason:"timeout")。不要继续当前任务。`,
    });
  }
});

// 通信矩阵检查 moved to OrchestratorRuntime (6d); called with { getState, applyEvent, pm }.


// ── 找离 childId 最近的 Leader 祖先，用于 Bash 审批路由 ──────────────────────
// findApproverLeader moved to ToolRuntime (6b); called with { agents, getState }.

// ── 通用 Leader 启动函数（PM depth=0 和 Tech Lead depth≥1 共用）────────────

export function killAgent(id: string, _reason = "interrupted"): void {
  for (const child of getState().agents.values()) {
    if (child.parent === id && child.state !== "done" && child.state !== "err" && !killedAgents.has(child.id)) killAgent(child.id, _reason);
  }
  killedAgents.add(id);
  agents.get(id)?.kill?.(); // clears queue, pops unresponded user msg, aborts HTTP
  abortAgent(id);           // clears pending approvals in store
  pm.cancelForeground(id);
  for (const [toolId, pending] of leaderApprovalQueue) {
    if (pending.workerChildId === id) leaderApprovalQueue.delete(toolId);
  }
  if (getState().agents.get(id)?.parent) {
    applyEvent({ v: 1, type: "agent.error", agent: id, code: "cancelled", detail: _reason });
    recordTaskCancellation(id, _reason);
  }
  if (getState().agents.get(id)?.parent) globalBus.unregisterAgent(id);
  // Release feishu serial lock so the next message for this PM isn't queued forever.
  feishuBusy.delete(id);
  // Phase B: remove from fork tracking so capacity count stays correct.
  for (const pmIds of feishuForks.values()) {
    if (pmIds.has(id)) { pmIds.delete(id); break; }
  }
  // Do NOT set state:err — httpAgent emits state:idle after AbortError,
  // which returns the agent to ready state so the user can resend immediately.
}

export async function shutdownRuntime(): Promise<void> {
  stopTaskRecovery();
  for (const [id, agent] of agents) { killedAgents.add(id); agent.kill(); }
  for (const secretary of secretaries.values()) secretary.destroy();
  pm.destroy();
  await cancelAllAgentTools();
  await waitTaskResolution();
  stopTaskRecovery();
  await waitForIndexing();
  releaseRuntimeOwners();
}

// replaceAgentForResume moved to OrchestratorRuntime (6d); called with { agents, secretaries, killedAgents }.

// ── 飞书桥接 ──────────────────────────────────────────────────────────────
// connectFeishu + all feishu* state moved to FeishuBridge.ts (6e).

// startLeaderAgent + startWorker moved to AgentHandlers.ts (6e).
// runDemo + runTestSuite + HEADLESS_SUITES moved to DevHarness.ts (6e)

