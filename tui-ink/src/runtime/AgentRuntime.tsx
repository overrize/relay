#!/usr/bin/env node
import {ShortcutInput} from "../tui/ShortcutInput.js";
import {HistorySearch} from "../tui/HistorySearch.js";
import {rememberPrompt,searchPrompts} from "../tui/PromptHistory.js";
import {selectSessionModel} from "../config.js";
import {editorLines} from '../tui/MultilineEditor.js';
import {displayWidth} from '../ui.js';
import {keybindings,Keybindings,keybindingsPath,keyHint,type KeyScope} from '../tui/Keybindings.js';
import {editExternally,terminalOwnership,cancelExternalEditor} from '../tui/ExternalEditor.js';
import {writeSnapshot} from '../memory/atomic.js';
import {configuredModels,cycleModel,uiPreferences,nextReasoning} from "../tui/interaction.js";
import {splitCommand} from "../tui/splitCommand.js";
import {syncModelPrices} from "../session/PriceSync.js";
import { sessionJournal } from "../session/Journal.js";
import { formatModelConfig } from "../tui/accountStatus.js";
import { LoginWizard } from "../tui/LoginWizard.js";
import {displayedPmModel} from "../tui/modelLabels.js";
import {configPath} from "../config.js";
import { releaseRuntimeOwners } from "../session/RuntimeOwner.js";
import { waitForIndexing } from "../session/SearchIndex.js";
import { stopTaskRecovery, waitTaskResolution, recordTaskCancellation } from "./TaskRecovery.js";
import { cancelAllAgentTools } from "../tools/command.js";
// Multi-agent TUI · entry
// ─────────────────────────────────────────────────────────────────────────────
// Layout: V1 三栏 inbox
//   ┌───── titlebar ─────┐
//   │  agents │ conv │ todo
//   │  input bar
//   │  status bar
//
// Flags:
//   --demo            don't actually spawn claude; emit fake events so the UI
//                     is testable without an API key. Recommend for first run.
//   --model=<id>      override leader model (default claude-sonnet-4-5)
//   --prompts=<dir>   directory holding _base.md / leader.md / ... (default ../prompts)

import React, { useCallback, useEffect, useRef, useState } from "react";
import { render, useApp, useInput, useStdin, Box, Text } from "ink";
import { execSync, spawnSync, spawn as nodeSpawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { HttpConvAgent } from "../adapters/httpAgent.js";
import { startHttpServer } from "../server/httpServer.js";
import {
  DISABLE_MOUSE_TRACKING, TERM_RESET, writeTermSync, buildExitRestoreSequence,
} from "./TerminalRestore.js";
import {
  TitleBar, AgentsPane, SessionsPane, ConvPane, TodoPane, StatusBar, InputBar, EffortBar, ModelBar,
  EFFORT_LEVELS, type Effort,
  DagView, VDivider, PaletteContext, PALETTES,
} from "../ui.js";
import {
  applyEvent, ensureAgent, getState, selectAgent, useStore, userMessage,
  approve, reject, abortAgent, setLayout, scrollBy, scrollAgentBy, setMinLevel, setEffort,
  resumeAgent, updateAgentInfo, clearDoneAgents, markPendingInput, pruneAgents, setTokenBudget,
  selectAgentVisible,
  setPendingRating, clearPendingRating,
  setFeishuConnection,
} from "../store.js";
import type { TuiEvent, LogLevel } from "../protocol.js";
import {
  loadConfig,
  savePalette,
  saveLayout,
  getAgentProviderConfig,
  isAgentConfigRole,
  resolveModelConfigInput,
  saveAgentModel,
  saveModelConfig,
  saveWebSearchProvider,
  saveWebSearchSelection,
} from "../config.js";
import type { PaletteName, AgentConfigRole, WebSearchProviderType } from "../config.js";
import { createRuntimeContext } from "./RuntimeContext.js";
import { SecretaryProxy } from "./MemoryRuntime.js";
import { createMemory, loadMemory, loadMemoryByHash, listUnfinishedAgents, deleteAgentMemory, topFactsByWeight, loadSessions, initSecretary, destroySecretary, buildResumeContext } from "./MemoryRuntime.js";
import { executeTool, toolNeedsApproval, buildToolSchemaBlock, runToolBatch, formatToolResults, findApproverLeader } from "./ToolRuntime.js";
import type { AgentRole } from "./ToolRuntime.js";
import { TestSuite } from "../tests/e2e/runner/TestSuite.js";
import { E2ESuite } from "../tests/e2e/runner/E2ESuite.js";
import { TokenManager } from "../feishu/auth.js";
import {
  sendTextMessage, addProcessingReaction, deleteProcessingReaction,
  patchCardMessage, replyToMessageWithText,
} from "../feishu/message.js";
import { feishuLog } from "../feishu/debug.js";
import { taskRegistry, cardIndex, pmCurrentTask } from "../feishu/session.js";
import { PMBridgeBase } from "../feishu/pm-bridge.js";
import { createTask, createCardRenderer } from "../feishu/card-renderer.js";
import { startFeishuWebSocket } from "../feishu/websocket.js";
import { FeishuReplyAggregator } from "../feishu/replyAggregator.js";
import { FeishuInputWindowManager } from "../feishu/input-window.js";
import { globalBus } from "../bus/Bus.js";
import { OutboundGateway } from "../feishu/outbound/OutboundGateway.js";
import { ConversationRuntime, TurnController, classifyFollowup, isStatusQuery, checkMessageLegal, replaceAgentForResume } from "./OrchestratorRuntime.js";
import { runDemo, runTestSuite } from "./DevHarness.js";
import { connectFeishu, configureFeishuBridge, isFeishuConnected, feishuSessionCount, getFeishuTokenManager, feishuMsgQueue, feishuReplyTarget, feishuForks, feishuBridge } from "./FeishuBridge.js";
import { buildCommands, type CmdDef } from "../tui/commands.js";
import { startLeaderAgent, startWorker, configureAgentHandlers } from "./AgentHandlers.js";
import { cursorAnchoredFrame } from "./CursorAnchor.js";
import { formatMetricsReport, getHealthMetricsStore, recordHealthMetric, logDiag, installDiagnosticSink } from "./ObservabilityRuntime.js";
import { SpawnHeader } from "../tui/Transcript.js";
import { config as dotenvConfig } from "dotenv";
// Load .env so FEISHU_APP_ID / FEISHU_APP_SECRET are available even without shell export
dotenvConfig();

// ── 路径 ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k: string) => argv.find((a) => a.startsWith(`--${k}`));
const DEMO = !!flag("demo");
const requestedMode = flag("mode")?.split("=")[1];
if (requestedMode) process.env.SPAWN_ORCHESTRATION = requestedMode;
const MODEL = flag("model")?.split("=")[1] ?? "claude-sonnet-4-5";
const PROMPTS_DIR = path.resolve(__dirname, "..", "..",
  flag("prompts")?.split("=")[1] ?? "../prompts");


// ── 拼系统 prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt(
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
const runtimeContext = createRuntimeContext();
const { agents, secretaries, pm, scheduledTasks, killedAgents, feishuBusy, pmPendingArtifacts, leaderApprovalQueue } = runtimeContext;
// 6e: inject runtime deps into FeishuBridge (startLeaderAgent is hoisted, safe to reference).
configureFeishuBridge({ agents, feishuBusy, killedAgents, pm, pmPendingArtifacts, startLeaderAgent });
// 6e: inject runtime deps into AgentHandlers (buildSystemPrompt/killAgent are hoisted).
configureAgentHandlers({ agents, killedAgents, pm, feishuBusy, secretaries, pmPendingArtifacts, leaderApprovalQueue, buildSystemPrompt, killAgent, MODEL, DEMO });
// Start HTTP REST API server (configurable via .env or default port 3001)
const serverPort = parseInt(process.env.SERVER_PORT ?? "3001", 10);
const serverEnabled = process.env.SERVER_ENABLED !== "false";
startHttpServer({ port: serverPort, enabled: serverEnabled, onMessage: (text, inputId) => {
  const root = agents.get("pm");
  if (root) root.receiveUserInput(text, inputId);
  else {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle" });
    startLeaderAgent({ id: "pm", firstMessage: text, inputId, promptFile: "pm" });
  }
} });
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
export interface LeaderOpts {
  id: string;
  parentId?: string;
  goal?: string;
  model?: string;
  depth?: number;
  parentChain?: string[];
  dispatch?: Extract<TuiEvent, { type: "spawn" }>["dispatch"];
  resumedMemoryId?: string;
  promptFile?: string;      // "pm" for root, "leader" for tech leads
  firstMessage?: string;    // override initial LLM message (used when PM first starts)
  replyHook?: (text: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }) => void; // called when message.to=user (Feishu bridge)
  turnEndHook?: () => void;            // called when Feishu PM turn ends — flushes aggregator
  conversationMode?: boolean;          // if true: stop after each user reply, no auto-nudge
  // Phase B: forked task options
  sharedSystemPrompt?: string;         // exact system prompt from base PM (enables cache reuse)
  initialMessages?: Array<{ role: "user" | "assistant"; content: string }>; // history snapshot
  inputId?: string;
  isForkedTask?: boolean;              // concurrent task with its own persisted secretary
}

function killAgent(id: string, _reason = "interrupted"): void {
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

async function shutdownRuntime(): Promise<void> {
  cancelExternalEditor();
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

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  useEffect(()=>{
    if(process.env.SPAWN_PRICE_AUTO_SYNC==="0")return;
    const controller=new AbortController();
    const sync=()=>{void syncModelPrices(Object.values(loadConfig().models),process.cwd(),{signal:controller.signal}).catch(()=>{});};
    sync();const timer=setInterval(sync,15*60000);timer.unref();return()=>{clearInterval(timer);controller.abort();};
  },[]);
  const { exit } = useApp();
  const { stdin, isRawModeSupported } = useStdin();
  const [input, setInput] = useState("");
  const [externalBusy,setExternalBusy]=useState(false);
  const [startupKeysError]=useState(()=>{try{keybindings.reload();return '';}catch(error){keybindings.configure({});return error instanceof Error?error.message:'无效配置';}});

  const agentList = useStore((s) =>
    Array.from(s.agents.entries()).filter(([, a]) => !a.hidden).map(([id]) => id));
  const sel = useStore((s) => s.selectedAgent);
  const pending = useStore((s) => s.pendingApprovals);
  const selectedPending = pending.filter((pa) => pa.agent === sel);
  const [paletteName, setPaletteName] = useState<PaletteName>(loadConfig().palette);
  const palette = PALETTES[paletteName];
  const layout = useStore((s) => s.layout);
  const scrollOffset     = useStore((s) => s.scrollOffset);
  const agentPaneScroll  = useStore((s) => s.agentPaneScroll);
  const effort           = useStore((s) => s.effort);
  const [effortSelecting, setEffortSelecting] = useState(false);
  const [modelSelecting, setModelSelecting] = useState(false);
  const [loginSelecting, setLoginSelecting] = useState(false);
  // Zen mode: hide left (AGENTS) and right (TODO) panes, keep only the centre ConvPane
  // so the conversation text can be selected/copied without sidebar columns interleaving.
  const [zenMode, setZenMode] = useState(false);
  // Status mode: show ONLY the left AGENTS pane (hide centre ConvPane + right TODO),
  // a focused view of agent statuses.
  const [statusMode, setStatusMode] = useState(false);
  const [exitSecsLeft, setExitSecsLeft] = useState(0);
  const exitConfirm                     = exitSecsLeft > 0;
  const exitConfirmTimer                = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastExitRequestAt               = useRef(0);
  const lastInputFocusLog               = useRef("");
  const cmdHistory      = useRef<string[]>([]);
  const [historySelecting,setHistorySelecting]=useState(false);
  useEffect(()=>{try{cmdHistory.current=searchPrompts('',100).reverse().map(r=>r.text);}catch{/* Search shows a readable error if the history database is unavailable. */}},[]);
  const historyIdx      = useRef(-1);
  const browsingHistory = useRef(false);
  const completeTick    = useRef(0);
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [dismissedSlash, setDismissedSlash] = useState<string | null>(null);
  // M3-7c interaction: view mode (Agents tree ↔ chat) + Plan drawer toggle.
  const [viewMode, setViewMode] = useState<"agents" | "chat" | "logs">("chat");
  const [planOpen, setPlanOpen] = useState(false);
  const [showTools,setShowTools]=useState(false),[showThinking,setShowThinking]=useState(true),[reasoningLabel,setReasoningLabel]=useState("default");
  const reasoningPending=useRef(false);
  // Ctrl+T / Ctrl+L are intercepted at the stdin layer (so the input field
  // never sees the char); register the React state toggles here.
  useEffect(() => {
    cancelLoginFromSignal=historySelecting?()=>setHistorySelecting(false):loginSelecting?()=>setLoginSelecting(false):modelSelecting?()=>setModelSelecting(false):effortSelecting?()=>setEffortSelecting(false):null;
    return()=>{cancelLoginFromSignal=null;};
  },[loginSelecting,modelSelecting,effortSelecting,historySelecting]);
  useEffect(() => {
    ctrlTHandler = () => {if(!loginSelecting&&!modelSelecting&&!effortSelecting&&!historySelecting)setShowThinking(v=>!v);};
    ctrlLHandler = () => {if(!loginSelecting&&!historySelecting){setEffortSelecting(false);setModelSelecting(true);}};
    return () => { ctrlTHandler = null; ctrlLHandler = null; };
  }, [loginSelecting,modelSelecting,effortSelecting,historySelecting]);

  // ── 消息队列 (agent busy 时暂存输入) ─────────────────────────────────────
  const msgQueue = useRef(new Map<string, string[]>());
  const [queueTick, setQueueTick] = useState(0);
  const bumpQueue = () => setQueueTick((t) => t + 1);

  // 当 agent 变成 idle 时，自动发出排队的消息
  const agentStates = useStore((s) =>
    Array.from(s.agents.entries()).map(([id, a]) => `${id}:${a.state}`).join(","),
  );
  useEffect(() => {
    const st = getState();
    let changed = false;
    for (const [agentId, msgs] of msgQueue.current.entries()) {
      const info = st.agents.get(agentId);
      if (info?.state === "idle" && msgs.length > 0) {
        const next = msgs.shift()!;
        const a = agents.get(agentId);
        if (a) a.sendCommand({ type: "user.message", text: next });
        changed = true;
      }
      if (msgs.length === 0) msgQueue.current.delete(agentId);
    }
    if (changed) bumpQueue();
  }, [agentStates]);

  const emitCommandMessage = (text: string) => {
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text } as TuiEvent);
  };

  const selectedConfigRole = (): AgentConfigRole => {
    const selected = getState().agents.get(getState().selectedAgent);
    if (selected?.role === "Worker") return "worker";
    if (selected?.role === "Secretary") return "secretary";
    return "leader";
  };
  const refreshModelLabels=()=>{const model=displayedPmModel(loadConfig(),agents.get("pm")?.cfg.providerCfg);if(getState().agents.get("pm")?.model!==model)updateAgentInfo("pm",{model});};
  useEffect(()=>{const file=configPath();fs.watchFile(file,{interval:500,persistent:false},refreshModelLabels);return()=>fs.unwatchFile(file,refreshModelLabels);},[]);

  const showModelConfig = () => {
    const cfg = loadConfig();
    emitCommandMessage(formatModelConfig(cfg));
  };

  const registerModelCommand = (
    name: string | undefined,
    preset: string | undefined,
    modelOrKey: string | undefined,
    maybeApiKey: string | undefined,
  ) => {
    if (!name || !preset || !modelOrKey) {
      emitCommandMessage("用法: /connect <name> <preset|baseUrl> [modelId] <apiKey>；订阅：/connect <name> <claude-subscription|codex-subscription|copilot-subscription> <modelId>");
      return;
    }
    const cfg = resolveModelConfigInput(preset, modelOrKey, maybeApiKey);
    if (!cfg) {
      emitCommandMessage("参数无效：API 需要模型和凭据；订阅只接受模型 ID，不接受额外 API Key。");
      return;
    }
    try {saveModelConfig(name, cfg);emitCommandMessage(`模型已注册: ${name} → ${cfg.provider}/${cfg.model} · ${cfg.billing?.mode??"api"} · ${cfg.transport??"http"}。配置在新启动/恢复时生效；/model show 查看候选链。`);}
    catch {emitCommandMessage("模型配置未保存；检查配置内容和配置目录写入权限。");}
  };

  const switchModelCommand = (
    role: string | undefined,
    modelName: string | undefined,
  ) => {
    if (!role || !modelName) {
      emitCommandMessage("用法: /model <leader|worker|secretary> <name>");
      return;
    }
    if (!isAgentConfigRole(role)) {
      emitCommandMessage(`未知 agent 角色 "${role}"，可用: leader, worker, secretary`);
      return;
    }
    const cfg = loadConfig();
    const modelCfg = cfg.models[modelName];
    if (!modelCfg) {
      emitCommandMessage(`未知模型 "${modelName}"。先用 /connect ${modelName} <preset|baseUrl> [modelId] <apiKey> 注册。`);
      return;
    }
    if (!saveAgentModel(role, modelName)) {
      emitCommandMessage(`模型切换失败: ${role} -> ${modelName}`);
      return;
    }
    if (role === "leader") refreshModelLabels();
    emitCommandMessage(`${role} 模型已切换: ${modelName} -> ${modelCfg.model} ✓`);
  };

  const confirmModelChoice = (role: AgentConfigRole, model: string, scope: "session" | "default" = "session") => {
    const cfg = loadConfig();
    const modelCfg = cfg.models[model];
    if (!modelCfg || !(scope === "default" ? saveAgentModel(role, model) : selectSessionModel(role, model))) {
      emitCommandMessage(`未知模型 "${model}"。先用 /connect 注册。`);
      setModelSelecting(false);
      return;
    }
    const target = role === "leader" ? agents.get("pm") : role === selectedConfigRole() ? agents.get(getState().selectedAgent) : undefined;
    if(target){const id=target.cfg.id;target.once('modelChanged',(model:string)=>updateAgentInfo(id,{model}));}
    target?.selectModel({name:model,config:getAgentProviderConfig(loadConfig(),role)});
    if (role === "leader") refreshModelLabels();
    setModelSelecting(false);
    emitCommandMessage(`${role} → ${modelCfg.model}（${scope === "default" ? "已保存默认" : "仅本次使用，重启恢复默认"}）；当前角色后续请求和新任务生效，进行中的请求保持原模型。`);
  };

  const showWebConfig = () => {
    const cfg = loadConfig();
    const providerLines = Object.entries(cfg.web.providers).map(([name, provider]) => {
      const active = name === cfg.web.search.provider ? "*" : " ";
      const details = provider.type === "serper"
        ? `${provider.type}${provider.hl ? ` hl=${provider.hl}` : ""}${provider.gl ? ` gl=${provider.gl}` : ""}`
        : provider.type;
      return `${active} ${name}: ${details} key=${provider.apiKey ? "***" : "(missing)"}`;
    });
    emitCommandMessage(
      `WebSearch: ${cfg.web.search.enabled ? "enabled" : "disabled"} provider=${cfg.web.search.provider}` +
      ` max=${cfg.web.search.maxResults ?? 5} timeout=${cfg.web.search.timeoutSeconds ?? 10}s\n` +
      `${providerLines.length ? providerLines.join("\n") : "(no configured web providers)"}\n\n` +
      `用法:\n/web connect <name> <serper|brave> <apiKey> [hl] [gl]\n/web provider <name>\n/web show`,
    );
  };

  const connectWebProviderCommand = (args: string[]) => {
    const [name, typeRaw, apiKey, hl, gl] = args;
    if (!name || !typeRaw || !apiKey) {
      emitCommandMessage("用法: /web connect <name> <serper|brave> <apiKey> [hl] [gl]");
      return;
    }
    const type = typeRaw as WebSearchProviderType;
    if (type !== "serper" && type !== "brave") {
      emitCommandMessage(`未知 WebSearch 供应商 "${typeRaw}"，可用: serper, brave`);
      return;
    }
    saveWebSearchProvider(name, {
      type,
      apiKey,
      ...(type === "serper" && hl ? { hl } : {}),
      ...(type === "serper" && gl ? { gl } : {}),
    });
    emitCommandMessage(`WebSearch 供应商已保存并启用: ${name} (${type}) ✓`);
  };

  const switchWebProviderCommand = (name: string | undefined) => {
    if (!name) {
      emitCommandMessage("用法: /web provider <name>");
      return;
    }
    if (!saveWebSearchSelection(name)) {
      emitCommandMessage(`未知 WebSearch 供应商 "${name}"。先用 /web connect ${name} <serper|brave> <apiKey> 注册。`);
      return;
    }
    emitCommandMessage(`WebSearch 默认供应商已切换: ${name} ✓`);
  };

  const pmStarted = useRef(false);
  async function openEditor(keys=false){
    if(externalBusy||terminalOwnership.external)return;
    const original=input.trim()==='/edit'?'':input;
    setExternalBusy(true);
    try{
      const content=keys?(fs.existsSync(keybindingsPath())?fs.readFileSync(keybindingsPath(),'utf8'):'{}\n'):original;
      const result=await editExternally(content,{
        validate:keys?text=>new Keybindings().configure(JSON.parse(text)):undefined,
        suspend:()=>{terminalOwnership.external=true;process.stdin.unpipe(filteredStdin);process.stdin.pause();if(process.stdin.isTTY)process.stdin.setRawMode(false);writeTermSync(TERM_RESET+'\x1b[2J\x1b[H');},
        resume:()=>{if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.pipe(filteredStdin,{end:false});process.stdin.resume();writeTermSync('\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h\x1b[?2004h');terminalOwnership.external=false;},
      });
      if(result.status==='complete'){
        if(keys){fs.mkdirSync(path.dirname(keybindingsPath()),{recursive:true});writeSnapshot(keybindingsPath(),result.content!);keybindings.reload();}
        else{setInput(result.content!);completeTick.current++;}
        emitCommandMessage(keys?'快捷键配置已校验、保存并重载。':'外部编辑完成，草稿已恢复；尚未发送。');
      }else{if(!keys)setInput(original);emitCommandMessage(`${result.reason}；恢复文件：${result.recoveryPath}`);}
    }catch{if(!keys)setInput(original);emitCommandMessage('外部编辑器配置或启动失败；原草稿保留。使用 editor.json 的 command 参数数组，或设置 VISUAL / EDITOR。');}
    finally{terminalOwnership.external=false;setExternalBusy(false);}
  }
  const showKeys=(reload:boolean)=>{try{if(reload)keybindings.reload();emitCommandMessage(`${keybindingsPath()}\n${keybindings.report()}${reload?'\n已重载。':''}`);}catch(error){emitCommandMessage(`${error instanceof Error?error.message:'快捷键配置无效'}；保留上次有效快捷键。`);}};
  useEffect(()=>{if(startupKeysError)emitCommandMessage(`快捷键配置未加载：${startupKeysError}；使用默认快捷键。`);},[]);
  const COMMANDS = buildCommands({
    agents, secretaries, pm, scheduledTasks, killedAgents,
    startLeaderAgent, startWorker, pmStarted,
    confirmEffort: (e) => confirmEffort(e),
    requestExit: () => requestExit(),
    setEffortSelecting, setModelSelecting, setPaletteName, setZenMode, setStatusMode,
    showModelConfig, switchModelCommand, registerModelCommand,
    showWebConfig, connectWebProviderCommand, switchWebProviderCommand,
    emitCommandMessage,
    setViewMode,togglePlan:()=>setPlanOpen(v=>!v),
    startLogin:()=>{setModelSelecting(false);setEffortSelecting(false);setLoginSelecting(true);},
    openEditor:keys=>{void openEditor(keys);},showKeys,
  });

  const runCommand = (cmd: string) => {
    const parts = /^prices(?:\s|$)/.test(cmd.slice(1))?splitCommand(cmd.slice(1)):cmd.slice(1).split(/\s+/);
    const head = parts[0]!;
    const c = COMMANDS.find((c) => c.name === head);
    if (c) c.handler(parts.slice(1));
  };

  const slashHead = input.startsWith("/") ? input.slice(1).split(/\s+/)[0]! : "";
  // slashMatches drives Tab completion — stays empty on bare "/" so Tab never
  // triggers completeTick++ (which remounts InputBar and drops the next keystroke).
  const slashMatches = slashHead
    ? COMMANDS.filter((c) => c.name.startsWith(slashHead))
    : [];
  // slashDisplay drives the visible dropdown — shows everything on bare "/"
  const slashDisplay = dismissedSlash === input || /\s/.test(input) ? [] : input === "/" ? COMMANDS : slashMatches;

  // Reset selection when the displayed list changes (user typed another char)
  const prevSlashKey = useRef("");
  const slashKey = slashDisplay.map((c) => c.name).join(",");
  if (prevSlashKey.current !== slashKey) {
    prevSlashKey.current = slashKey;
    if (slashSelectedIdx !== 0) setSlashSelectedIdx(0);
  }

  const SLASH_MAX_VISIBLE = 8;
  const slashScrollStart = slashSelectedIdx < 0
    ? 0
    : Math.min(Math.max(0, slashSelectedIdx - SLASH_MAX_VISIBLE + 1),
               Math.max(0, slashDisplay.length - SLASH_MAX_VISIBLE));
  const slashVisible = slashDisplay.slice(slashScrollStart, slashScrollStart + SLASH_MAX_VISIBLE);
  // 1 separator + visible items + 1 "N more" line if truncated
  const slashPaneRows = slashDisplay.length > 0
    ? 2 + slashVisible.length + (slashDisplay.length > SLASH_MAX_VISIBLE ? 1 : 0)
    : 0;
  const editorLineCount=editorLines(input,Math.max(1,(process.stdout.columns??80)-9),displayWidth).length;
  const editorMaxRows=Math.max(2,Math.min(8,Math.floor((process.stdout.rows??24)/3)));
  const editorExtraRows=Math.min(editorMaxRows,editorLineCount)-1+(editorLineCount>editorMaxRows?1:0);


  const dispatchUser = (raw: string) => {
    const text = raw.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      // Only treat as a slash command if the first word matches a known command.
      // Paths like /home/user/file.txt should pass through as regular messages.
      const head = text.slice(1).split(/\s+/)[0]!;
      // Slash commands emit their output into PM's conversation — run the handler
      // (it reads the current selectedAgent where relevant), then switch view to PM
      // so the result is actually visible instead of hidden behind whatever TL/worker
      // page was selected.
      if (COMMANDS.some((c) => c.name === head)) { runCommand(text); selectAgent("pm"); return; }
    }

    let target = getState().selectedAgent;
    const m = text.match(/^@(\S+)\s+(.+)$/s);
    let body = text;
    if (m) { target = m[1]!; body = m[2]!; selectAgent(target); }

    // "不理人" fix: a target with no live LLM instance (system/monitor agent, a
    // done/cleaned-up agent, or the not-yet-started PM) can't receive a message.
    // Route to the PM — the conversation entry point — instead of dropping it.
    if (target !== "pm" && !agents.get(target)) { target = "pm"; selectAgent("pm"); }

    if (target === "pm" && !pmStarted.current) {
      userMessage("pm", body);
      pmStarted.current = true;
      const existing = agents.get("pm");
      if (existing) existing.receiveUserInput(body);
      else startLeaderAgent({ id: "pm", firstMessage: body, promptFile: "pm" });
      return;
    }

    // New PM message: clear done agents and any pending rating from the previous task.
    if (target === "pm") { clearDoneAgents(); clearPendingRating(); }
    userMessage(target, body);
    const a = agents.get(target);
    if (!a) {
      // Should be unreachable after the reroute above; never drop silently.
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `⚠ 无法送达 "${target}"（该 agent 无活动实例）。已选中 pm，请重发。` });
      selectAgent("pm");
      return;
    }

    // Mark pending so the UI shows activity even if the agent is busy and
    // queues the message. Cleared automatically when agent.state:run fires.
    markPendingInput(target);

    // If user re-engages a killed agent, clear its killed status so dead-parent
    // guards don't block any child agents it spawns next.
    killedAgents.delete(target);

    // HttpConvAgent has its own internal _queue and drains one message per turn,
    // so we always call sendCommand immediately — no React-level blocking needed.
    a.receiveUserInput(body);
  };

  useEffect(() => {
    const timer = setInterval(() => {
      const due = scheduledTasks.due(Date.now());
      for (const ev of due) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `⏰ 计划任务触发 ${ev.task.id}: ${ev.task.text}` });
        dispatchUser(`@pm [计划任务 ${ev.task.id}] ${ev.task.text}`);
        scheduledTasks.complete(ev.task.id);
      }
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }, []);

  // 启动: 注册 PM + process-monitor 占位，检查未完成会话
  useEffect(() => {
    const cfg = loadConfig();
    const leaderCfg = getAgentProviderConfig(cfg, "leader");
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle", sub: "waiting for first message", model: displayedPmModel(cfg) });
    // process-monitor: visual representation of the TypeScript ProcessManager in the agent tree
    ensureAgent({ id: "process-monitor", name: "monitor", role: "Secretary", parent: "pm", state: "idle", sub: "", model: "internal" });

    // On startup: if there's an unfinished PM session, prompt the user to decide.
    // Do NOT auto-resume — the user may want to start a fresh session instead.
    const resumeId = flag("resume")?.split("=")[1] || "pm";
    if (flag("resume") && sessionJournal().binding(resumeId) && !pmStarted.current) {
      if (sessionJournal().binding(resumeId)?.parent) throw new Error("--resume requires a root PM; use /resume for individual tasks");
      if (!sessionJournal().isCurrent(resumeId)) throw new Error("Cannot resume an obsolete task; resume its PM instead");
      pmStarted.current = resumeId === "pm";
      ensureAgent({ id: resumeId, name: resumeId, role: "Leader", state: "idle" });
      startLeaderAgent({ id: resumeId, resumedMemoryId: resumeId, promptFile: "pm" });
    }
    const pmMem = loadMemory("pm");
    if (pmMem && pmMem.tombstone?.final_status === null && !pmStarted.current) {
      const hash = pmMem.session_hash ? pmMem.session_hash.slice(0, 8) : "?";
      const hint = (pmMem.tombstone.resume_hint ?? "(无记录)").slice(0, 120);
      const deadWorkers = listUnfinishedAgents()
        .filter((m) => m.parent_chain?.includes("pm") && m.agent_id !== "pm")
        .map((m) => m.agent_id);
      const deadNote = deadWorkers.length > 0
        ? `\n⚠ 上次存在子 agent：${deadWorkers.join(", ")}`
        : "";
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `🔔 检测到上次未完成的会话 (${hash})\n上次状态：${hint}${deadNote}\n\n/resume — 继续上次任务\n直接提问 — 查询当前任务；/revise 新目标 — 替换目标并停止旧执行` });
    }

    // Auto-connect Feishu if credentials are present in .env
    const feishuAppId = process.env.FEISHU_APP_ID;
    const feishuAppSecret = process.env.FEISHU_APP_SECRET;
    if (feishuAppId && feishuAppSecret) {
      connectFeishu(feishuAppId, feishuAppSecret);
    }
  }, []);

  // Paste and mouse framing are decoded once in ShortcutInput, before Ink.
  useEffect(() => {
    if (!isRawModeSupported) return;
    process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?2004h");
    return () => writeTermSync("\x1b[?1000l\x1b[?1006l\x1b[?2004l");
  }, [isRawModeSupported]);
  const EFFORT_DESC_SHORT: Record<Effort, string> = {
    min:  "PM 优先自理，仅复杂多文件任务才 spawn TL",
    mid:  "默认平衡，对话/单文件自理，其余 spawn TL",
    high: "激进派发，任何工具调用都优先 spawn TL",
    max:  "全双工，spawn 后立即回待命，不等 TL 完成",
  };

  const confirmEffort = (e: Effort) => {
    setEffort(e);
    setEffortSelecting(false);
    // Notify PM so it can adjust spawning strategy immediately
    const pm = agents.get("pm");
    if (pm) {
      pm.sendCommand({
        type: "user.message",
        text: `[系统-effort] effort 已调整为 "${e}"。${EFFORT_DESC_SHORT[e]}。请根据新等级调整后续 spawn 决策。`,
      });
    }
    applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
      text: `⚡ effort → ${e}  (${EFFORT_DESC_SHORT[e]})` });
  };

  // Restore last user message to input box (shared by ESC-run and ESC-idle paths)
  const restoreLastUserMessage = (agentId: string) => {
    const msgs = getState().messagesByAgent.get(agentId);
    if (!msgs) return;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.agent === "user") {
        const text = msgs[i]!.text ?? "";
        setInput(text);
        if (!cmdHistory.current.length || cmdHistory.current[cmdHistory.current.length - 1] !== text) {
          cmdHistory.current.push(text);
          historyIdx.current = -1;
          browsingHistory.current = false;
        }
        return;
      }
    }
  };

  const handleESCInterrupt = () => {
    const selId = getState().selectedAgent;
    const selState = getState().agents.get(selId)?.state;
    if (selState === "run" || selState === "idle") {
      killAgent(selId);
      applyEvent({ v: 1, type: "message", agent: selId, to: "user",
        text: `⏹ interrupted — edit your message above and resend` });
      // Load the last user message back into the input box, just like Claude Code:
      // user can immediately edit and resend without retyping from scratch.
      restoreLastUserMessage(selId);
    } else {
      // Agent not running — ESC loads last message for re-editing
      restoreLastUserMessage(selId);
    }
  };

  const requestExit = (immediate=false) => {
    const now = Date.now();
    if (now - lastExitRequestAt.current < 120) return;
    lastExitRequestAt.current = now;
    if (exitConfirm||immediate) {
      if (exitConfirmTimer.current) clearInterval(exitConfirmTimer.current);
      void shutdownRuntime().finally(() => {
        exit();
        writeTermSync(TERM_RESET);
        process.exit(0);
      });
      return;
    }
    setExitSecsLeft(3);
    exitConfirmTimer.current = setInterval(() => {
      setExitSecsLeft((s) => {
        if (s <= 1) {
          clearInterval(exitConfirmTimer.current!);
          exitConfirmTimer.current = null;
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    const clearOrExit=()=>{if(input)setInput("");else requestExit();};
    requestExitFromSignal = clearOrExit;
    return () => {if(requestExitFromSignal===clearOrExit)requestExitFromSignal=null;};
  });

  useEffect(() => {
    const focused = selectedPending.length === 0 && !modelSelecting && !effortSelecting;
    const signature = [
      `sel=${sel}`,
      `focused=${focused}`,
      `inputLen=${input.length}`,
      `pendingSel=${selectedPending.length}`,
      `pendingAll=${pending.length}`,
      `model=${modelSelecting}`,
      `effort=${effortSelecting}`,
    ].join(" ");
    if (signature !== lastInputFocusLog.current) {
      lastInputFocusLog.current = signature;
      logDiag(`[input] ${signature}\n`);
    }
  }, [sel, input.length, selectedPending.length, pending.length, modelSelecting, effortSelecting]);

  // 全局快捷键
  useEffect(()=>{
    keyboardScope=modelSelecting?'model':loginSelecting||effortSelecting?'login':historySelecting?'history':viewMode==='agents'?'agents':'compose';
    controlKeyHandler=code=>{
      if(terminalOwnership.external||externalBusy)return;
      if(code===0x12){if(!loginSelecting&&!modelSelecting&&!effortSelecting&&!selectedPending.length)setHistorySelecting(true);return;}
      if(historySelecting)return;
      if(loginSelecting||modelSelecting||effortSelecting||selectedPending.length)return;
      if(code===0x04){if(!input)requestExit(true);return;}
      if(code===0x07){void openEditor();return;}
      if(code===0x02){setViewMode(v=>v==="agents"?"chat":"agents");return;}
      if(code===0x0f){setShowTools(v=>!v);return;}
      if(code===0x10||code===0x80){const cfg=loadConfig(),role=selectedConfigRole(),chosen=cycleModel(cfg.models,cfg.agents[role].model,code===0x80?-1:1,uiPreferences().favorites);if(chosen)confirmModelChoice(role,chosen);else emitCommandMessage("暂无已接入模型，请 /login。");}
    };
    return()=>{controlKeyHandler=null;};
  });

  useInput((char, key) => {
    if(loginSelecting||modelSelecting||effortSelecting||historySelecting||externalBusy)return; // The active selector exclusively owns text, Tab and Esc.
    if (key.ctrl && char === "c") { requestExit(); return; }
    if(key.ctrl&&char==="d"&&!input){requestExit(true);return;}
    if(!modelSelecting&&!effortSelecting&&selectedPending.length===0){
      if(key.ctrl&&char==="g"){setViewMode(v=>v==="agents"?"chat":"agents");return;}
      if(key.ctrl&&char==="o"){setShowTools(v=>!v);return;}
      if(key.ctrl&&char==="p"||key.meta&&char==="p"){
        const cfg=loadConfig(),role=selectedConfigRole(),chosen=cycleModel(cfg.models,cfg.agents[role].model,key.meta?-1:1,uiPreferences().favorites);if(chosen)confirmModelChoice(role,chosen);else emitCommandMessage("暂无已接入模型，请 /login。");return;
      }
      if(key.tab&&key.shift){
        if(reasoningPending.current)return;reasoningPending.current=true;
        const cfg=loadConfig(),role=selectedConfigRole(),name=cfg.agents[role].model,model=cfg.models[name]!;
        emitCommandMessage("正在读取当前模型的推理能力；PM 沟通继续。");
        void nextReasoning(model).then(level=>{
          if(!level){emitCommandMessage("此接入尚未声明可调推理级别；保持模型默认设置。分工策略使用 /strategy。");return;}
          if(loadConfig().agents[role].model!==name){emitCommandMessage("模型已切换，未应用过期推理设置。");return;}
          saveModelConfig(name,{...model,reasoningEffort:level});const active=agents.get(getState().selectedAgent),pc=active?.cfg.providerCfg;
          if(pc&&pc.provider===model.provider&&pc.model===model.model&&pc.baseUrl===model.baseUrl&&pc.apiKey===model.apiKey)active!.cfg.providerCfg={...pc,reasoningEffort:level};
          setReasoningLabel(level);emitCommandMessage(`推理强度 → ${level}；后续请求生效，进行中的调用不变。`);
        }).catch(()=>emitCommandMessage("推理能力查询未完成，保持原设置；没有猜测或发送新推理参数。")).finally(()=>{reasoningPending.current=false;});return;
      }
    }
    // ── M3-7c view-mode keys (only when composing nothing) ──────────────────
    // Ctrl+T / Ctrl+L handled at the stdin layer (see filteredStdin) so the
    // input field doesn't receive the literal char.
    // View navigation + agent selection (Tab always; ↑/↓ when in the Agents tree).
    const navAgent = (dir: 1 | -1) => {
      const ids = agentList;
      if (!ids.length) return;
      const idx = ids.indexOf(sel);
      const next = idx < 0 ? 0 : (idx + dir + ids.length) % ids.length;
      const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
      selectAgentVisible(ids[next]!, maxVis);
    };
    if (!input && selectedPending.length === 0 && !modelSelecting && !effortSelecting) {
      if (viewMode === "agents" && (key.upArrow || key.downArrow)) {
        navAgent(key.upArrow ? -1 : 1); return;
      }
      if (viewMode === "agents" && key.return) { setViewMode("chat"); return; }
    }

    if (key.tab && !input) {
      if (modelSelecting) setModelSelecting(false);
      if (effortSelecting) setEffortSelecting(false);
      navAgent(1);
      return;
    }
    if (modelSelecting) {
      if (key.escape) setModelSelecting(false);
      return;
    }
    // Only handle ESC here when InputBar is NOT focused (pending approvals).
    // When InputBar is focused (pending.length===0), it handles ESC itself via onESC prop.
    // Handling it in both places caused double "⏹ interrupted by ESC" messages.
    if (key.escape && selectedPending.length > 0) { handleESCInterrupt(); return; }

    // 待审批时 y/n 接管
    if (selectedPending.length > 0) {
      if (char === "y") {
        const m = selectedPending[0]!;
        const toolId = m.tool_id!;
        approve(toolId);
        const agentInst = agents.get(m.agent);
        if (agentInst) {
          executeTool(m.tool_name ?? "", m.tool_args, { agentId: m.agent, revision: m.session_revision, callId: toolId }).then((r) => {
            if (!sessionJournal().isCurrent(m.agent, m.session_revision)) return;
            applyEvent({ v: 1, type: "tool.result", agent: m.agent, id: toolId, ok: r.ok, output: r.output });
            agentInst.sendCommand({ type: "tool.result", id: toolId, ok: r.ok, output: r.output });
          });
        }
        return;
      }
      if (char === "n") {
        const m = selectedPending[0]!;
        const toolId = m.tool_id!;
        reject(toolId);
        const agentInst = agents.get(m.agent);
        if (agentInst) {
          const errMsg = "Tool rejected by user";
          applyEvent({ v: 1, type: "tool.result", agent: m.agent, id: toolId, ok: false, output: errMsg });
          agentInst.sendCommand({ type: "tool.result", id: toolId, ok: false, output: errMsg });
        }
        return;
      }
    }

    // Scroll shortcuts — [ scroll up (older), ] scroll down (newer), when input empty
    if (!input) {
      if (char === "[") { scrollBy(3);  return; } // older = hide 3 recent msgs
      if (char === "]") { scrollBy(-3); return; } // newer = unhide 3 recent msgs
    }

    // P/F/C/E/M shortcuts — only when not typing and no pending approvals
    if (viewMode==="agents" && !input && selectedPending.length === 0) {
      // E — open effort selector (ESC/Enter handled inside EffortBar's own useInput)
      if (char === "E" && !effortSelecting) { setEffortSelecting(true); return; }
      if (key.escape && effortSelecting)    { setEffortSelecting(false); return; }
      if (char === "M" && !effortSelecting) { setModelSelecting(true); return; }
      if (char === "P") {
        const id = getState().selectedAgent;
        agents.get(id)?.kill?.();
        applyEvent({ v: 1, type: "message", agent: id, to: "user", text: `⏸ paused by user` });
        return;
      }
      if (char === "F") {
        const selId = getState().selectedAgent;
        const selInfo = getState().agents.get(selId);
        // F forks a Tech Lead from PM, or a Worker from a Tech Lead
        const isLeaderLevel = !selInfo?.parent || selId === "pm";
        const child = isLeaderLevel
          ? `tl-${Date.now().toString(36).slice(-4)}`
          : `worker-${Date.now().toString(36).slice(-4)}`;
        const role: "Leader" | "Worker" = isLeaderLevel ? "Leader" : "Worker";
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: selId, child, role,
          goal: "(awaiting instructions — type your task)",
          dispatch: { background: `Forked from ${selId} by user`, constraints: [],
            acceptance_criteria: ["agent.done"], stop_conditions: ["agent.done"] },
        };
        const parentRole = getState().agents.get(selId)?.role;
        const check = pm.preCheckSpawn(spawnEv, parentRole);
        if (!check.ok) {
          applyEvent({ v: 1, type: "agent.error", agent: selId, code: check.code, detail: check.detail });
          return;
        }
        applyEvent(spawnEv);
        pm.observe(spawnEv);
        startWorker(spawnEv);
        return;
      }
      if (char === "C") {
        const id = getState().selectedAgent;
        const info = getState().agents.get(id);
        applyEvent({ v: 1, type: "message", agent: id, to: "user",
          text: `⚙ ${info?.name ?? id}\nrole: ${info?.role ?? "?"}\nmodel: ${info?.model ?? "?"}\nparent: ${info?.parent ?? "-"}\nstate: ${info?.state ?? "?"}`,
        });
        return;
      }
    }

    // 斜杠补全选择 — ↑/↓ 在列表中移动，优先于历史导航
    if (input.startsWith("/") && slashDisplay.length > 0) {
      if (key.upArrow) {
        setSlashSelectedIdx((p) => (p <= 0 ? slashDisplay.length - 1 : p - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSelectedIdx((p) => (p >= slashDisplay.length - 1 ? 0 : p + 1));
        return;
      }
    }

    // 命令历史 — ↑ 回溯, ↓ 前进
    if (key.upArrow && (input === "" || browsingHistory.current && !input.includes('\n'))) {
      if (cmdHistory.current.length === 0) return;
      browsingHistory.current = true;
      const idx = Math.min(historyIdx.current + 1, cmdHistory.current.length - 1);
      historyIdx.current = idx;
      setInput(cmdHistory.current[cmdHistory.current.length - 1 - idx]!);
      return;
    }
    if (key.downArrow && browsingHistory.current && !input.includes('\n')) {
      if (historyIdx.current > 0) {
        historyIdx.current--;
        setInput(cmdHistory.current[cmdHistory.current.length - 1 - historyIdx.current]!);
      } else {
        historyIdx.current = -1;
        browsingHistory.current = false;
        setInput("");
      }
      return;
    }

    if (key.tab) {
      if (input.startsWith("/")) {
        // 斜杠模式：有选中项则补全选中，否则 LCP 补全
        const selected = slashSelectedIdx >= 0 ? slashDisplay[slashSelectedIdx] : undefined;
        if (selected) {
          setInput("/" + selected.name + " ");
          setSlashSelectedIdx(-1);
          completeTick.current++;
        } else if (slashMatches.length === 1) {
          setInput("/" + slashMatches[0]!.name + " ");
          completeTick.current++;
        } else if (slashMatches.length > 1) {
          const commonPrefix = lcp(slashMatches.map((m) => m.name));
          const newInput = "/" + commonPrefix;
          if (newInput !== input) { setInput(newInput); completeTick.current++; }
        }
        return;
      }
      // agent 切换 — 仅在非斜杠模式
      const ids = agentList;
      if (!ids.length) return;
      const idx = ids.indexOf(sel);
      const maxVis = Math.max(3, Math.floor(Math.max(6, (process.stdout.rows ?? 24) - 5) / 3));
      const nextIdx = idx >= 0 ? (idx + 1) % ids.length : 0;
      selectAgentVisible(ids[nextIdx]!, maxVis);
    }
  });

  return (
    <PaletteContext.Provider value={palette}>
      <Box flexDirection="column" height={process.stdout.rows ?? 24}>
        <Box flexDirection="column" flexGrow={1}>
          {viewMode === "agents" ? (
            <>
              {/* Home banner: stable in the Agents view (not tied to the selected
                  agent's messages). It's gone once you Enter into a chat. */}
              <SpawnHeader model={displayedPmModel(loadConfig(),agents.get("pm")?.cfg.providerCfg)} />
              <Box paddingLeft={1}><Text dimColor>↑/↓ select · Enter open · Ctrl+G chat · Ctrl+L models</Text></Box>
              <AgentsPane width={process.stdout.columns ?? 80} scroll={agentPaneScroll} />
            </>
          ) : viewMode === "logs" ? (
            <Box flexDirection="column" flexGrow={1} paddingX={1}>
              <Text dimColor>logs · {getState().selectedAgent} · Ctrl+G agents · /chat · Esc interrupt</Text>
              {(getState().messagesByAgent.get(getState().selectedAgent) ?? []).slice(-60).map((m) => (
                <Text key={m.id} dimColor wrap="truncate-end">[{m.kind}] {(m.text ?? "").split("\n")[0]}</Text>
              ))}
            </Box>
          ) : (
            <>
              <Box paddingLeft={1}><Text dimColor>{getState().selectedAgent} · {keyHint('app.model.select')} 模型 · {keyHint('app.history.search')} 历史 · {keyHint('app.editor.external')} 编辑器 · /keys</Text></Box>
              <ConvPane scrollOffset={scrollOffset} completionRows={slashPaneRows+editorExtraRows} showTools={showTools} showThinking={showThinking} />
            </>
          )}
        </Box>
        {planOpen && (() => {
          const todos = getState().todosByAgent.get(getState().selectedAgent) ?? [];
          const rule = "─".repeat(process.stdout.columns ?? 80);
          return (
            <Box flexDirection="column" flexShrink={0}>
              <Text dimColor>{rule}</Text>
              <Box paddingX={1}><Text bold>Plan</Text><Text dimColor>  ({getState().selectedAgent})  /plan close</Text></Box>
              {todos.length === 0
                ? <Box paddingX={1}><Text dimColor italic>no plan yet</Text></Box>
                : todos.map((t, i) => (
                    <Box key={t.id} paddingX={1}>
                      <Text color={t.state === "done" ? "green" : t.state === "run" ? "cyan" : undefined}>
                        {`${i + 1}. [${t.state === "done" ? "done" : t.state === "run" ? "run " : "todo"}] `}
                      </Text>
                      <Text dimColor={t.state === "todo"} wrap="truncate-end">{t.text}</Text>
                    </Box>
                  ))}
            </Box>
          );
        })()}
        {historySelecting
          ? <HistorySearch onSelect={text=>{setInput(text);setDismissedSlash(null);setHistorySelecting(false);completeTick.current++;setViewMode("chat");}} onCancel={()=>setHistorySelecting(false)} />
          : loginSelecting
          ? <LoginWizard onDone={message=>{setLoginSelecting(false);refreshModelLabels();emitCommandMessage(message);}} onCancel={()=>setLoginSelecting(false)} />
          : modelSelecting
          ? (() => {
              const cfg = loadConfig();
              const modelChoices = configuredModels(cfg.models);
              const modelDescriptions = Object.fromEntries(
                Object.entries(cfg.models).map(([name, modelCfg]) => [
                  name,
                  `${modelCfg.model} · ${modelCfg.provider} · ${modelCfg.billing?.mode??"api"} · ${name}`,
                ]),
              );
              return <ModelBar
                currentRole={selectedConfigRole()}
                currentModelByRole={{
                  leader: cfg.agents.leader.model,
                  worker: cfg.agents.worker.model,
                  secretary: cfg.agents.secretary.model,
                }}
                modelChoices={modelChoices}
                modelDescriptions={modelDescriptions}
                onConfirm={confirmModelChoice}
                onCancel={() => setModelSelecting(false)}
              />;
            })()
          : effortSelecting
          ? <EffortBar current={effort} onConfirm={confirmEffort} onCancel={() => setEffortSelecting(false)} />
          : <>
              {slashDisplay.length > 0 && (
                <>
                  <Box>
                    <Text dimColor>{"─".repeat(process.stdout.columns ?? 80)}</Text>
                  </Box>
                  <Box paddingX={2} flexDirection="column" flexShrink={1}>
                    {slashVisible.map((c, i) => {
                      const absIdx = slashScrollStart + i;
                      const selected = absIdx === slashSelectedIdx;
                      return (
                        <Box key={c.name}>
                          <Text color="cyan" inverse={selected}>{`${selected ? "→" : " "} /${c.name}`.padEnd(14)}</Text>
                          <Text dimColor={!selected}> {c.desc}</Text>
                        </Box>
                      );
                    })}
                    {slashDisplay.length > SLASH_MAX_VISIBLE && (
                      <Text dimColor>  {"·".repeat(3)} {slashDisplay.length - SLASH_MAX_VISIBLE} more</Text>
                    )}
                    <Text dimColor>{keyHint('tui.editor.up')} / {keyHint('tui.editor.down')} 选择 · {keyHint('tui.input.submit')} 执行 · {keyHint('tui.editor.complete')} 补全 · {keyHint('app.interrupt')} 关闭</Text>
                  </Box>
                </>
              )}
              <InputBar
                key={completeTick.current}
                focused={selectedPending.length === 0&&!externalBusy}
                value={input}
                menuActive={slashDisplay.length>0}
                onChange={value=>{setDismissedSlash(null);browsingHistory.current=false;historyIdx.current=-1;setInput(value);}}
                onESC={()=>{if(slashDisplay.length){setDismissedSlash(input);return;}handleESCInterrupt();}}
                onSubmit={(v) => {
                  // 斜杠命令：回车时若面板有匹配，解析成选中(或首个)命令，
                  // 避免把 "/mo" 这种前缀当普通消息发出去（表现为"直接输入斜杠"）。
                  let toSend = v;
                  if (v.startsWith("/") && slashDisplay.length > 0) {
                    const sel =
                      slashSelectedIdx >= 0 && slashSelectedIdx < slashDisplay.length
                        ? slashDisplay[slashSelectedIdx]
                        : slashDisplay[0];
                    if (sel) {
                      const spaceIdx = v.indexOf(" ");
                      const args = spaceIdx >= 0 ? v.slice(spaceIdx) : "";
                      toSend = `/${sel.name}${args}`;
                    }
                  }
                  if (toSend.trim()) {
                    cmdHistory.current.push(toSend.trim());
                    try{rememberPrompt(toSend);}catch{emitCommandMessage("本次输入未写入搜索历史：历史库不可写，当前消息仍会正常发送。");}
                    historyIdx.current = -1;
                    browsingHistory.current = false;
                  }
                  dispatchUser(toSend);
                  setInput("");
                  setViewMode("chat"); // submitting a message → show the conversation
                }}
                hint={
                  selectedPending.length > 0
                    ? `[${selectedPending[0]!.agent}] ${selectedPending[0]!.tool_name ?? ""} — y approve · n reject`
                    : pending.length > 0
                    ? `${pending.length} pending approval(s) in other agent(s) — Tab to review`
                    : getState().pendingRating
                    ? "Session done — /rate good [comment] or /rate bad [comment] to rate"
                    : (() => {
                        const sel = getState().selectedAgent;
                        const selState = getState().agents.get(sel)?.state;
                        const hasPendingInput = getState().pendingInputAgents.has(sel);
                        if (selState === "run") return "working… (ESC to interrupt)";
                        if (hasPendingInput)    return "message queued, waiting for agent…";
                        return undefined;
                      })()
                }
              />
            </>
        }
        {(()=>{const cols=Math.max(20,(process.stdout.columns??80)-2),cfg=loadConfig(),pc=agents.get(getState().selectedAgent)?.cfg.providerCfg??cfg.models[cfg.agents[selectedConfigRole()].model]!,right=`${pc.model} · ${pc.reasoningEffort??"default"}`,rightWidth=Math.min(Math.floor(cols*0.65),right.length),leftWidth=Math.max(3,cols-rightWidth-2);return <Box paddingX={1} justifyContent="space-between"><Text dimColor>{`Relay ${process.cwd().slice(-Math.max(1,leftWidth-6))}`}</Text><Text color="magenta">{right.slice(0,rightWidth)}</Text></Box>;})()}
        <StatusBar demo={DEMO} exitConfirm={exitConfirm} exitSecsLeft={exitSecsLeft} effort={effort} />
      </Box>
    </PaletteContext.Provider>
  );
}

// ── utils ────────────────────────────────────────────────────────────────────
function lcp(strs: string[]): string {
  if (!strs.length) return "";
  let prefix = strs[0]!;
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    if (!prefix) break;
  }
  return prefix;
}

// ── boot ────────────────────────────────────────────────────────────────────
// Windows cmd/PowerShell defaults to GBK; force UTF-8 so Chinese log lines
// written to stderr are not garbled. No-op on Linux/macOS.
if (process.platform === "win32") {
  process.stderr.setEncoding("utf8");
  try { execSync("chcp 65001", { stdio: "ignore" }); } catch { /* best-effort */ }
}

// Tee stderr to a UTF-8 log file so it can be viewed correctly on Windows
// regardless of the terminal's codepage.
const LOG_FILE = path.join(process.cwd(), "tui.log");
(function setupLogFile() {
  const logStream = fs.createWriteStream(LOG_FILE, { encoding: "utf8", flags: "a" });
  const sessionStart = Date.now();
  logStream.write(`\n--- session ${new Date().toISOString()} ---\n`);
  const origWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
  const mirrorToTerminal = process.env.SPAWN_TTY_LOGS === "1";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, encodingOrCb?: any, cb?: any): boolean => {
    const text = typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    // Prepend +elapsed ms timestamp to each line (skip blank lines and escape sequences)
    const elapsed = `+${((Date.now() - sessionStart) / 1000).toFixed(1)}s`;
    const timestamped = text.replace(/^(?!\x1b)(.)/mg, `${elapsed} $1`);
    logStream.write(timestamped);
    if (mirrorToTerminal) return origWrite(chunk, encodingOrCb, cb);
    const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
    if (callback) queueMicrotask(callback);
    return true;
  };
})();

const banner = DEMO
  ? "running in --demo mode (no real claude subprocess; fake events on first message)"
  : `live mode — model=${getAgentProviderConfig(loadConfig(), "leader").model}, orchestration=${pm.getMode()}`;

console.log(`\nRelay · 接力 · ${banner}\n`);

// ── rg (ripgrep) probe — Grep/Glob tools require it ─────────────────────────
// spawnSync accepts shell: boolean; execSync only accepts shell: string.
// Full command in string — do NOT split args when shell:true (shell receives them as $0/$1).
const _rgCheck = spawnSync("rg --version", [], { stdio: "ignore", shell: true });
if (_rgCheck.error || _rgCheck.status !== 0) {
  console.warn("⚠  ripgrep (rg) not found — Grep/Glob tools will be unavailable.");
  console.warn("   Install: apt install ripgrep  |  brew install ripgrep  |  cargo install ripgrep\n");
}

// ── stdin passthrough ───────────────────────────────────────────────────────
// Mouse tracking IS enabled at runtime (wheel scrolling — see the \x1b[?1000h
// effect in App). Start from a known-clean slate here: a previous run that died
// without restoring would otherwise leave the terminal reporting.
// Restore sequences and the synchronous writer live in TerminalRestore.ts —
// see that file for why an async stdout write does not survive exit on Windows.
writeTermSync(DISABLE_MOUSE_TRACKING);

const filteredStdin = new ShortcutInput(code=>{
  if(code===0x03){if(cancelLoginFromSignal)cancelLoginFromSignal();else if(requestExitFromSignal)requestExitFromSignal();else process.exit(130);}
  else if(code===0x14)ctrlTHandler?.();
  else if(code===0x0c)ctrlLHandler?.();
  else controlKeyHandler?.(code);
},(button,column)=>{
  if(button!==64&&button!==65)return;
  const direction=button===64?-1:1;
  if(column<=23){const total=getState().agents.size,maxVis=Math.max(3,Math.floor(Math.max(6,(process.stdout.rows??24)-5)/3));scrollAgentBy(direction,total,maxVis);}
  else scrollBy(-3*direction);
},(bytes,final)=>keybindings.resolve(bytes,keyboardScope,final));
process.stdin.pipe(filteredStdin, { end: false });

Object.defineProperties(filteredStdin, {
  isTTY: { get: () => process.stdin.isTTY },
  setRawMode: { value: (mode: boolean) => { if(terminalOwnership.external)return;try { process.stdin.setRawMode(mode); } catch { /* non-TTY fallback */ } } },
  ref: { value: () => process.stdin.ref() },
  unref: { value: () => process.stdin.unref() },
});

// Re-disable on exit — covers clean exit, SIGINT (Ctrl+C), and SIGTERM.
// Every path writes synchronously (see writeTermSync): an async stdout write
// here does not survive process teardown on Windows.
function restoreTerminalForExit(): void {
  writeTermSync(buildExitRestoreSequence(process.stdout.rows ?? 24));
}
process.on("exit", restoreTerminalForExit);
process.on("SIGTERM", () => { writeTermSync(TERM_RESET); void shutdownRuntime().finally(() => process.exit(143)); });

let requestExitFromSignal: (() => void) | null = null;
let cancelLoginFromSignal:(()=>void)|null=null;
// Control-shortcut handlers, registered by App; fired from filteredStdin so the
// input field never receives the char (fixes Ctrl+T typing a literal 't').
let controlKeyHandler:((code:number)=>void)|null=null;
let keyboardScope:KeyScope='compose';
let ctrlTHandler: (() => void) | null = null;
let ctrlLHandler: (() => void) | null = null;
process.on("SIGINT", () => {
  if(terminalOwnership.external)return; // The foreground editor owns Ctrl+C; do not kill PM.
  if(cancelLoginFromSignal){cancelLoginFromSignal();return;}
  writeTermSync(TERM_RESET);
  if (requestExitFromSignal) {
    requestExitFromSignal();
    return;
  }
  process.exit(130);
});

// ── Synchronized output — prevent lower-half flicker ───────────────────────
// Ink's log-update writes each frame as one stream.write() call:
//   stream.write(eraseLines(N) + newContent)
// The terminal renders lines as they arrive, so the user sees old content
// being erased top-to-bottom before new content fills in → visible flicker.
//
// DEC private mode 2026 (supported by Windows Terminal, kitty, iTerm2, etc.)
// tells the terminal to buffer the entire write and flip the frame atomically.
// Unknown terminals silently ignore the sequence, so this is safe everywhere.
{
  const _orig = process.stdout.write.bind(process.stdout);
  let _inside = false;
  // @ts-ignore — intentional write shim
  process.stdout.write = function (chunk: any, ...rest: any[]): boolean {
    if(terminalOwnership.external){const callback=rest.find(v=>typeof v==='function');if(callback)queueMicrotask(()=>callback());return true;}
    if (_inside) return _orig(chunk, ...rest);
    const s: string = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // Ink frame writes always contain eraseLines (\x1b[1A\x1b[2K) or
    // clearTerminal (\x1b[2J\x1b[H). Wrap those — and only those — in
    // synchronized-output begin/end markers.
    if (s.includes("\x1b[1A") || s.includes("\x1b[2J")) {
      _inside = true;
      const r = _orig(`\x1b[?2026h${cursorAnchoredFrame(s)}\x1b[?2026l`, ...rest);
      _inside = false;
      return r;
    }
    return _orig(chunk, ...rest);
  };
}

// Route diagnostic stderr to tui.log while the interactive TUI runs. The app
// emits many raw logDiag agent-event logs; written to the terminal they corrupt
// Ink's <Static> line tracking (stranded status bar / blank gaps). A file keeps
// the terminal clean for Ink. (Skipped for non-TTY: tests/CI, and demo.)
installDiagnosticSink({ isTTY: !!process.stdout.isTTY, demo: DEMO, logFile: path.join(process.cwd(), "tui.log") });

render(<App />, { stdin: filteredStdin as any, exitOnCtrlC: false });
