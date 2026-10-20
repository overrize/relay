import { sessionJournal } from "../session/Journal.js";
import { inputKind } from "../session/Control.js";
/**
 * FeishuBridge — the Feishu WebSocket bridge + all Feishu-only module state
 * (spawn-1.0 M1-6e). Extracted verbatim from the god-file. Owns the feishu* state;
 * AgentRuntime injects its runtime deps via configureFeishuBridge() and reads the
 * few cross-cutting bits (msg queue / reply target / token mgr / bridge / forks /
 * connected flag) through the exported accessors. Not golden-covered → smoke Feishu.
 */

import path from "node:path";
import fs from "node:fs";
import * as crypto from "node:crypto";

import type { TuiEvent } from "../protocol.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";
import type { ProcessManager } from "../pm/ProcessManager.js";
import type { LeaderOpts } from "./AgentRuntime.js";
import {
  applyEvent, getState, ensureAgent, selectAgent, userMessage, markPendingInput,
  setFeishuConnection,
} from "../store.js";
import { loadConfig, getAgentProviderConfig } from "../config.js";
import { ConversationRuntime, classifyFollowup, isStatusQuery } from "./OrchestratorRuntime.js";

import { TokenManager } from "../feishu/auth.js";
import {
  sendTextMessage, addProcessingReaction, deleteProcessingReaction,
  patchCardMessage, replyToMessageWithText,
  hasInlineAttachments, sendInlineAttachments, autoSendImagePaths,
} from "../feishu/message.js";
import { feishuLog } from "../feishu/debug.js";
import { taskRegistry, cardIndex, pmCurrentTask } from "../feishu/session.js";
import { PMBridgeBase } from "../feishu/pm-bridge.js";
import { createTask, createCardRenderer } from "../feishu/card-renderer.js";
import { startFeishuWebSocket } from "../feishu/websocket.js";
import { FeishuReplyAggregator } from "../feishu/replyAggregator.js";
import { FeishuInputWindowManager } from "../feishu/input-window.js";
import { OutboundGateway } from "../feishu/outbound/OutboundGateway.js";

// ── injected runtime deps ────────────────────────────────────────────────────
interface FeishuDeps {
  agents: Map<string, HttpConvAgent>;
  feishuBusy: Set<string>;
  killedAgents: Set<string>;
  pm: ProcessManager;
  pmPendingArtifacts: Map<string, string[]>;
  startLeaderAgent: (opts: LeaderOpts) => void;
}
let _deps: FeishuDeps | null = null;
export function configureFeishuBridge(deps: FeishuDeps): void { _deps = deps; }

// ── Feishu-only module state (moved verbatim from AgentRuntime) ───────────────
const feishuSessions = new Map<string, string>();
let feishuConnected = false;
// Per-PM message queue: messages that arrived while the agent was mid-turn.
// Stores { text, messageId } so the dequeue path can anchor the reply card correctly.
const feishuMsgQueue = new Map<string, Array<{ text: string; messageId: string }>>();
// Set of PM IDs currently processing a turn (busy = don't inject new messages)
// Where to reply: stored per-PM so queued delivery can route correctly
const feishuReplyTarget = new Map<string, { replyId: string; replyType: 'open_id' | 'chat_id' }>();
// Shared tokenManager + event bridge (set once in connectFeishu)
let feishuTokenManager: TokenManager | null = null;
const feishuBridge = new PMBridgeBase();
// Dedup: 5s same-content guard per user (catches rapid re-sends / UI double-taps)
// Event-ID dedup is already handled at the WS layer (websocket.ts seenEventIds, 500-entry LRU)
const feishuRecentTexts = new Map<string, { text: string; time: number }>(); // openId → last msg
// Per-PM reply aggregator: coalesces N fallback fragments into one Feishu send per turn
const feishuAggregators = new Map<string, FeishuReplyAggregator>(); // pmId → aggregator
// Input merge window: silence gap (ms) before flushing buffered consecutive messages
const FEISHU_INPUT_WINDOW_MS = 1500;
// Phase B: concurrent task tracking
// feishuForks: openId → Set of forked PM' ids currently running (excludes the base session PM)
const feishuForks = new Map<string, Set<string>>();
// feishuPendingQueue: messages that arrived when all concurrent slots were full
const feishuPendingQueue = new Map<string, Array<{ text: string; anchorMsgId: string; chatId: string; chatType: string }>>();
// feishuCheckpoints: pmId → last confirmed-clean message history (captured after each base-PM turn).
// Fork tasks use this snapshot instead of live messages to prevent cross-contamination with
// in-flight sibling turns (Bug 1 fix).
const feishuCheckpoints = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
// feishuForkBuffer: completed fork Q/As awaiting merge into base PM history on the next
// base PM turnEnd. Keyed by openId; entries carry arrival seq for stable ordering.
let feishuForkSeq = 0;
const feishuForkBuffer = new Map<string, Array<{
  seq: number;
  anchorMsgId: string;
  question: string;
  answer: string;
}>>();
// max total concurrent tasks per openId (base PM + forks)
const FEISHU_MAX_CONCURRENT = 3;

export function connectFeishu(appId: string, appSecret: string): void {
  const { agents, feishuBusy, killedAgents, pm, pmPendingArtifacts, startLeaderAgent } = _deps!;
  if (feishuConnected) {
    setFeishuConnection({ enabled: true, connected: true, status: "已连接" });
    return;
  }
  feishuConnected = true;
  setFeishuConnection({ enabled: true, connected: false, status: "连接中" });
  process.env.FEISHU_APP_ID = appId;
  process.env.FEISHU_APP_SECRET = appSecret;
  const tokenManager = new TokenManager();
  feishuTokenManager = tokenManager;
  tokenManager.getToken().catch(() => { /* pre-warm; will retry on first send */ });

  // Wire card renderer to the bridge (one-time subscription per connection)
  feishuBridge.subscribe(createCardRenderer(tokenManager));

  const cfg = loadConfig();
  const leaderProviderCfg = getAgentProviderConfig(cfg, "leader");
  const conversationRuntimeShadow = new ConversationRuntime({
    maxConcurrent: FEISHU_MAX_CONCURRENT,
    autoDrainOnComplete: false,
    makeBasePmId: (openId) => `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`,
  });
  const shadowForkByAnchor = new Map<string, string>();
  const shadowLog = (label: string, actions: unknown[]): void => {
    if (process.env.SPAWN_SHADOW_RUNTIME !== "1") return;
    feishuLog(`[ConversationRuntime:shadow] ${label} ${JSON.stringify(actions).slice(0, 1000)}`);
  };
  const shadowAccept = (openId: string, text: string, messageId: string): void => {
    const actions = conversationRuntimeShadow.accept({ conversationId: openId, text, messageId });
    for (const action of actions) {
      if (action.type === "fork_start") shadowForkByAnchor.set(messageId, action.forkId);
    }
    shadowLog("accept", actions);
  };
  const shadowCompleteFork = (openId: string, messageId: string, answer: string): void => {
    const forkId = shadowForkByAnchor.get(messageId);
    if (!forkId) return;
    const actions = conversationRuntimeShadow.completeFork(openId, forkId, answer);
    shadowLog("completeFork", actions);
  };
  const shadowCompleteBase = (openId: string, pmId: string): void => {
    const bpm = agents.get(pmId);
    if (!(bpm instanceof HttpConvAgent)) return;
    const actions = conversationRuntimeShadow.completeBase(openId, bpm.getMessages());
    shadowLog("completeBase", actions);
  };

  // Helper: start a new task for pmId, emit task_spawned, send placeholder card
  const startTask = (pmId: string, rt: { replyId: string; replyType: 'open_id' | 'chat_id' }, msgId: string): void => {
    const task = createTask({ pmId, ...rt, rootMessageId: msgId }, tokenManager);
    taskRegistry.set(task.taskId, task);
    pmCurrentTask.set(pmId, task.taskId);
    feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🦞 PM' });
    // Reaction-only indicator — reply card is created on first PM response (no placeholder)
    if (msgId) {
      addProcessingReaction(msgId, tokenManager)
        .then((rid) => { task.reactionId = rid; })
        .catch(() => {});
    }
  };

  const buildBusyStatusReply = (openIdLocal: string, pmId: string): string => {
    const state = getState();
    const base = state.agents.get(pmId);
    const queueLen = feishuMsgQueue.get(pmId)?.length ?? 0;
    const overflowLen = feishuPendingQueue.get(openIdLocal)?.length ?? 0;
    const forkIds = Array.from(feishuForks.get(openIdLocal) ?? []);
    const descendants = Array.from(state.agents.values())
      .filter((agent) => agent.parent === pmId || forkIds.includes(agent.id))
      .filter((agent) => agent.state === "run" || agent.state === "idle")
      .slice(0, 4);
    const activeText = descendants.length > 0
      ? descendants.map((agent) => `${agent.id}(${agent.state}${agent.sub ? `: ${agent.sub}` : ""})`).join(" / ")
      : "暂无子任务";
    const taskId = pmCurrentTask.get(pmId);
    const lines = [
      "当前还在处理上一轮任务，我先给你状态，不把这条插进业务队列。",
      `base: ${base?.name ?? pmId} ${base?.state ?? "unknown"}${base?.sub ? ` - ${base.sub}` : ""}`,
      `活跃子任务: ${activeText}`,
      `base 追问队列: ${queueLen} 条；并发溢出队列: ${overflowLen} 条；并发 fork: ${forkIds.length} 个`,
    ];
    if (taskId) lines.push(`当前任务 ID: ${taskId}`);
    lines.push("建议：要开新工作请用「新任务 ...」；要追问上一轮可继续短句。");
    return lines.join("\n");
  };

  // createAggregator: one aggregator per PM session.
  // sendBubble → format=text: reply as text bubble anchored under the user's message.
  // sendCard   → format=document: route to card renderer for a structured card.
  // Note: text arrives pre-sanitized from the OutboundGateway (markdown stripped for text,
  // kept for document). The aggregator only needs to route, not re-sanitize.
  const finalSentByRootMessage = new Set<string>();
  const finalGuardKey = (taskId: string, pmIdLocal: string): string | null => {
    const task = taskRegistry.get(taskId);
    if (!task) return null;
    return task.rootMessageId || `${pmIdLocal}:${taskId}`;
  };
  const hasFinalSent = (taskId: string, pmIdLocal: string): boolean => {
    const task = taskRegistry.get(taskId);
    const key = finalGuardKey(taskId, pmIdLocal);
    if (!task || !key) return true;
    if (finalSentByRootMessage.has(key) || task.status === "done") {
      feishuLog(`[FeishuFinalGuard] suppressed duplicate final task=${taskId} pm=${pmIdLocal} root=${key}`);
      return true;
    }
    return false;
  };
  const markFinalSent = (taskId: string, pmIdLocal: string): void => {
    const key = finalGuardKey(taskId, pmIdLocal);
    if (key) finalSentByRootMessage.add(key);
  };
  const claimFinalSend = (taskId: string, pmIdLocal: string): boolean => {
    if (hasFinalSent(taskId, pmIdLocal)) {
      return false;
    }
    markFinalSent(taskId, pmIdLocal);
    return true;
  };
  const displayAgentName = (agentId?: string): string => {
    if (!agentId) return "PM";
    if (agentId === "pm" || /^feishu-[0-9a-f]{8}$/.test(agentId)) return `PM ${agentId}`;
    if (agentId.startsWith("feishu-fork-")) return `Fork ${agentId}`;
    const info = getState().agents.get(agentId);
    const role = info?.role ?? "Agent";
    return `${role} ${agentId}`;
  };
  const appendResponderNote = (text: string, agentId?: string, taskId?: string): string => {
    const taskNote = taskId ? `\n任务 ID：${taskId}` : "";
    return `${text.trim()}\n\n回答 agent：${displayAgentName(agentId)}${taskNote}`;
  };
  const createAggregator = (pmIdLocal: string): FeishuReplyAggregator =>
    new FeishuReplyAggregator(
      // sendBubble
      async (text: string, meta?: { agentId?: string }) => {
        const taskId = pmCurrentTask.get(pmIdLocal);
        if (!taskId) return;
        if (hasFinalSent(taskId, pmIdLocal)) return;
        const task = taskRegistry.get(taskId);
        if (!task) return;
        const elapsedSec = ((Date.now() - task.startedAt) / 1000).toFixed(1);
        // Inline attachments: [[image:path]] / [[file:path]] → upload + send, strip markers.
        let bodyText = text;
        if (hasInlineAttachments(text)) {
          bodyText = await sendInlineAttachments(task.replyId, task.replyType, text, tokenManager);
        }
        // Fallback: even without markers, auto-send any existing local image path the reply
        // mentions — so the user gets the image even when the model refuses to "send" it.
        await autoSendImagePaths(task.replyId, task.replyType, bodyText, tokenManager);
        if (bodyText) {
          const withTiming = `${appendResponderNote(bodyText, meta?.agentId, taskId)}\n⏱ ${elapsedSec}s`;
          // 长回复(>50 字)开话题(thread)，避免长文刷屏；短回复维持普通气泡。
          const useThread = bodyText.length > 50;
          if (task.rootMessageId) {
            await replyToMessageWithText(task.rootMessageId, withTiming, tokenManager, useThread);
          } else {
            await sendTextMessage(task.replyId, task.replyType, withTiming, tokenManager);
          }
        }
        if (task.reactionId && task.rootMessageId) {
          deleteProcessingReaction(task.rootMessageId, task.reactionId, tokenManager);
        }
        markFinalSent(taskId, pmIdLocal);
        task.status = 'done';
      },
      // sendCard
      async (text: string, meta?: { agentId?: string }) => {
        const taskId = pmCurrentTask.get(pmIdLocal);
        if (!taskId) return;
        if (!claimFinalSend(taskId, pmIdLocal)) return;
        // Attachments also work on the document/card path: upload [[image]]/[[file]]
        // markers and auto-send any mentioned local image path before the card.
        const task = taskRegistry.get(taskId);
        if (task) {
          let cardText = text;
          if (hasInlineAttachments(text)) {
            cardText = await sendInlineAttachments(task.replyId, task.replyType, text, tokenManager);
          }
          await autoSendImagePaths(task.replyId, task.replyType, cardText, tokenManager);
        }
        const finalText = appendResponderNote(text, meta?.agentId, taskId);
        feishuBridge.emit({ type: 'agent_done', taskId, agentPath: 'PM', finalText });
        feishuBridge.emit({ type: 'task_done', taskId, summary: finalText });
      },
    );

  // Unified outbound gateway — all message.to=user content flows through this.
  const outboundGateway = new OutboundGateway(
    (pmId) => feishuAggregators.get(pmId),
    (pmId) => pmPendingArtifacts.get(pmId),
    (pmId) => { pmPendingArtifacts.delete(pmId); },
  );

  // makeGatewayHook: factory for the replyHook option passed to startLeaderAgent.
  // Computes dynamic context (active children) and routes into the OutboundGateway.
  const makeGatewayHook = (pmIdLocal: string) =>
    (replyText: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }): void => {
      const activeChildren = Array.from(getState().agents.values()).filter(
        (ag) => ag.parent === pmIdLocal && (ag.state === "run" || ag.state === "idle"),
      );
      outboundGateway.accept(
        { text: replyText, format, _fallback: meta?._fallback ?? false, agentId: meta?.agentId ?? pmIdLocal },
        { pmId: pmIdLocal, conversationMode: true, hasActiveChildren: activeChildren.length > 0 },
      );
    };

  // drainPendingQueue: when a task slot frees up, try to start the oldest pending message.
  const drainPendingQueue = (openId: string): void => {
    const pending = feishuPendingQueue.get(openId);
    if (!pending || pending.length === 0) return;
    const forkCount = feishuForks.get(openId)?.size ?? 0;
    const baseBusy = feishuBusy.has(
      `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`
    );
    const totalRunning = (baseBusy ? 1 : 0) + forkCount;
    if (totalRunning >= FEISHU_MAX_CONCURRENT) return;
    const next = pending.shift();
    if (!next) return;
    feishuLog(`[FeishuConcurrent] draining pending for openId=...${openId.slice(-6)}, remaining=${pending.length}`);
    dispatchMessage(openId, next.text, next.anchorMsgId, next.chatId, next.chatType);
  };

  // flushForkBufferToBase: call ONLY when base PM is idle (about to receive a new message).
  // Injects all completed fork Q/As from the buffer into base PM's live messages[] and
  // updates the checkpoint so the new message's context contains full fork history.
  const flushForkBufferToBase = (openId: string, pmId: string): void => {
    const buf = feishuForkBuffer.get(openId);
    if (!buf || buf.length === 0) return;
    const bpm = agents.get(pmId);
    if (!(bpm instanceof HttpConvAgent)) return;
    buf.sort((a, b) => a.seq - b.seq);
    const forkEntries = buf.flatMap(c => ([
      { role: "user"      as const, content: c.question },
      { role: "assistant" as const, content: c.answer   },
    ]));
    bpm.appendHistory(forkEntries);
    feishuCheckpoints.set(pmId, bpm.getMessages());
    feishuForkBuffer.delete(openId);
    feishuLog(`[FeishuConcurrent] pre-dispatch flush: ${buf.length} fork Q/As → ${pmId}`);
  };

  // startConcurrentTask: fork a new lightweight PM' for a concurrent task.
  // The fork shares the base PM's exact systemPrompt (Anthropic cache hit) and
  // gets a compacted snapshot of the base PM's current message history.
  const startConcurrentTask = (
    openId: string,
    sessionPmId: string,
    text: string,
    anchorMsgId: string,
    chatId: string,
    chatType: string,
  ): void => {
    const replyId   = chatType === 'group' ? chatId : openId;
    const replyType: 'open_id' | 'chat_id' = chatType === 'group' ? 'chat_id' : 'open_id';
    const rt = { replyId, replyType };

    // Create a Feishu task for this fork (anchored at anchorMsgId, NOT sessionPmId's current task).
    const task = createTask({ pmId: sessionPmId, ...rt, rootMessageId: anchorMsgId }, tokenManager);
    taskRegistry.set(task.taskId, task);

    const forkId = `feishu-fork-${task.taskId.slice(-8)}`;
    pmCurrentTask.set(forkId, task.taskId);

    // Record arrival order so the buffer can be merged in question-arrival order
    // rather than completion order (multiple forks completing out of order).
    const forkArrivalSeq = ++feishuForkSeq;

    // Capture the fork's reply text so we can merge Q/A back into base PM history.
    let forkAnswer = "";
    const forkReplyHook = (replyText: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }): void => {
      // Only accumulate non-fallback text into history
      if (!meta?._fallback) {
        forkAnswer += (forkAnswer ? "\n" : "") + replyText;
      }
      makeGatewayHook(forkId)(replyText, format, meta);
    };

    // Snapshot: use the last confirmed-clean checkpoint (captured after the previous base-PM
    // turn completed) rather than live getMessages(). The live array is dirty — it already
    // contains the in-flight Q that base PM is currently processing, which would make the
    // fork repeat the sibling answer before answering its own question (Bug 1 fix).
    const sessionPm = agents.get(sessionPmId);
    const rawCheckpoint = feishuCheckpoints.get(sessionPmId) ?? [];
    // Phase E: peek at any fork Q/As buffered but not yet merged into checkpoint.
    // Buffer is NOT consumed — base-idle flush or turnEnd will do that.
    // This ensures a new fork sees all completed concurrent work as context.
    const bufPeek = feishuForkBuffer.get(openId);
    const pendingForkMsgs: Array<{ role: "user" | "assistant"; content: string }> =
      bufPeek && bufPeek.length > 0
        ? [...bufPeek].sort((a, b) => a.seq - b.seq).flatMap(c => ([
            { role: "user"      as const, content: c.question },
            { role: "assistant" as const, content: c.answer   },
          ]))
        : [];
    const snapshot = HttpConvAgent.compactHistoryByTokens([...rawCheckpoint, ...pendingForkMsgs], 10_000);
    const sharedSysPrompt = sessionPm instanceof HttpConvAgent
      ? sessionPm.getSystemPrompt()
      : undefined;

    // Register fork in tracking set.
    const forks = feishuForks.get(openId) ?? new Set<string>();
    forks.add(forkId);
    feishuForks.set(openId, forks);

    feishuBusy.add(forkId);
    feishuAggregators.set(forkId, createAggregator(forkId));
    ensureAgent({
      id: forkId,
      name: `飞书:${openId.slice(-4)}↳${task.taskId.slice(-4)}`,
      role: "Leader",
      state: "idle",
      sub: "并发任务",
      model: leaderProviderCfg.model,
    });

    feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🔀 PM fork' });
    if (anchorMsgId) {
      addProcessingReaction(anchorMsgId, tokenManager)
        .then((rid) => { task.reactionId = rid; })
        .catch(() => {});
    }

    userMessage(forkId, text);
    startLeaderAgent({
      id: forkId,
      promptFile: "pm",
      conversationMode: true,
      isForkedTask: true,
      sharedSystemPrompt: sharedSysPrompt,
      initialMessages: snapshot,
      firstMessage: text, inputId: anchorMsgId || undefined,
      replyHook: forkReplyHook,
      turnEndHook: () => {
        outboundGateway.flush(forkId);
        feishuBusy.delete(forkId);
        shadowCompleteFork(openId, anchorMsgId, forkAnswer);
        // Buffer Q/A for merge back into base PM history on next base PM turnEnd.
        // Only buffer when the fork actually produced a reply (skip silent failures).
        if (forkAnswer) {
          const buf = feishuForkBuffer.get(openId) ?? [];
          buf.push({ seq: forkArrivalSeq, anchorMsgId, question: text, answer: forkAnswer });
          feishuForkBuffer.set(openId, buf);
          feishuLog(`[FeishuConcurrent] fork ${forkId} buffered Q/A (seq=${forkArrivalSeq})`);
        }
        feishuForks.get(openId)?.delete(forkId);
        if (feishuForks.get(openId)?.size === 0) feishuForks.delete(openId);
        drainPendingQueue(openId);
      },
    });
    feishuLog(
      `[FeishuConcurrent] forked ${forkId} for openId=...${openId.slice(-6)}` +
      ` forks=${feishuForks.get(openId)?.size ?? 0}/${FEISHU_MAX_CONCURRENT - 1}`,
    );
  };

  // dispatchMessage: inner function called by the input-window manager after the
  // silence gap expires. anchorMsgId is the FIRST fragment's message ID and is
  // used as the Feishu reaction / reply-card anchor for the whole merged turn.
  let inputMgr!: FeishuInputWindowManager; // assigned below; safe in closures

  const dispatchMessage = (
    openId: string,
    text: string,
    anchorMsgId: string,
    chatId: string,
    chatType: string,
  ): void => {
    // Safety net: websocket.ts already filters empty messages, but guard here too
    // so non-WS callers (tests, direct invocations) can't accidentally spawn PM with empty input.
    if (!text.trim()) {
      feishuLog(`[FeishuBridge] empty text from ...${openId.slice(-6)}, skipped`);
      return;
    }
    shadowAccept(openId, text, anchorMsgId);
    const pmId = `feishu-${crypto.createHash("sha256").update(openId).digest("hex").slice(0, 8)}`;
    if (anchorMsgId) {
      const j = sessionJournal();
      j.append("inbox.received", pmId, pmId, j.current(pmId)?.revision ?? 0, { id: anchorMsgId, text, channel: "feishu", metadata: { openId, chatId, chatType } });
    }
    const replyId   = chatType === 'group' ? chatId : openId;
    const replyType: 'open_id' | 'chat_id' = chatType === 'group' ? 'chat_id' : 'open_id';
    const rt = { replyId, replyType };

    if (!feishuSessions.has(openId)) {
      // ── New session ────────────────────────────────────────────────────────
      // Guard: if the PM with this deterministic ID already exists (e.g. session
      // map was cleared but agent survived), reconnect instead of re-spawning.
      if (agents.has(pmId)) {
        feishuLog(`[FeishuBridge] reconnect: PM ${pmId} alive but session lost — re-wiring`);
        feishuSessions.set(openId, pmId);
        if (!feishuBusy.has(pmId)) {
          feishuBusy.add(pmId);
          feishuReplyTarget.set(pmId, rt);
          startTask(pmId, rt, anchorMsgId);
          userMessage(pmId, text);
          killedAgents.delete(pmId);
          feishuLog(`[feishu-pm-inject] reconnect → PM ${pmId} text="${text.slice(0, 120)}" (len=${text.length})`);
          agents.get(pmId)!.receiveUserInput(text, anchorMsgId || undefined);
        } else {
          agents.get(pmId)!.receiveUserInput(text, anchorMsgId || undefined);
          feishuLog(`[FeishuBridge] reconnect-busy: durably queued for ${pmId}`);
        }
        return;
      }
      feishuLog(`[FeishuBridge] new session pmId=${pmId}`);
      feishuSessions.set(openId, pmId);
      feishuBusy.add(pmId);
      feishuReplyTarget.set(pmId, rt);
      startTask(pmId, rt, anchorMsgId);
      ensureAgent({ id: pmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
        sub: "飞书会话", model: leaderProviderCfg.model });
      feishuAggregators.set(pmId, createAggregator(pmId));
      userMessage(pmId, text);
      feishuLog(`[feishu-pm-inject] new session → PM ${pmId} firstMessage="${text.slice(0, 120)}" (len=${text.length})`);
      startLeaderAgent({ id: pmId, firstMessage: text, inputId: anchorMsgId || undefined, promptFile: "pm",
        conversationMode: true, replyHook: makeGatewayHook(pmId),
        turnEndHook: () => {
          feishuBusy.delete(pmId); // pre-clear: drain routing fix (Bug 2)
          shadowCompleteBase(openId, pmId);
          const bpm = agents.get(pmId);
          if (bpm instanceof HttpConvAgent) {
            let cleanHistory = bpm.getMessages();
            // Merge any completed fork Q/As in arrival order so subsequent turns
            // (base PM and future forks) can see all concurrent work done so far.
            const buf = feishuForkBuffer.get(openId);
            if (buf && buf.length > 0) {
              buf.sort((a, b) => a.seq - b.seq);
              const forkEntries = buf.flatMap(c => ([
                { role: "user"      as const, content: c.question },
                { role: "assistant" as const, content: c.answer   },
              ]));
              cleanHistory = cleanHistory.concat(forkEntries);
              bpm.appendHistory(forkEntries); // inject into base PM's live messages
              feishuForkBuffer.delete(openId);
              feishuLog(`[FeishuConcurrent] merged ${buf.length} fork Q/As into ${pmId} history`);
            }
            feishuCheckpoints.set(pmId, cleanHistory);
          }
          outboundGateway.flush(pmId);
          drainPendingQueue(openId);
        } });
    } else {
      // ── Existing session ───────────────────────────────────────────────────
      const existingPmId = feishuSessions.get(openId)!;
      const a = agents.get(existingPmId);
      feishuLog(
        `[FeishuBridge] existing pmId=${existingPmId} alive=${a instanceof HttpConvAgent} busy=${feishuBusy.has(existingPmId)}`,
      );
      if (a instanceof HttpConvAgent) {
        if ((inputKind(text) === "change" || inputKind(text) === "constraint") && !/^(新任务|另一个任务|并行|另外帮我|new task|in parallel)/i.test(text)) {
          userMessage(existingPmId, text);
          killedAgents.delete(existingPmId);
          a.receiveUserInput(text, anchorMsgId || undefined);
          return;
        }
        if (feishuBusy.has(existingPmId)) {
          if (isStatusQuery(text)) {
            const statusText = buildBusyStatusReply(openId, existingPmId);
            feishuLog(
              `[FeishuStatus] immediate busy status for ${existingPmId}` +
              ` text="${text.slice(0, 80)}"`,
            );
            if (anchorMsgId) {
              replyToMessageWithText(anchorMsgId, statusText, tokenManager).catch((err) => {
                feishuLog(`[FeishuStatus] reply failed: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
            sessionJournal().dispatched(anchorMsgId);
            return;
          }

          // Keep obvious follow-ups on the same PM history. Independent messages
          // can still fork for full-duplex concurrency.
          const followup = classifyFollowup(text);
          if (followup.isFollowup) {
            userMessage(existingPmId, text);
            a.receiveUserInput(text, anchorMsgId || undefined);
            return;
          }

          // Phase B: base PM is busy → try to fork a concurrent independent task.
          const forkCount = feishuForks.get(openId)?.size ?? 0;
          if (forkCount < FEISHU_MAX_CONCURRENT - 1) {
            startConcurrentTask(openId, existingPmId, text, anchorMsgId, chatId, chatType);
          } else {
            // All slots full → overflow queue + ⏳ reaction so user sees acknowledgement.
            const pending = feishuPendingQueue.get(openId) ?? [];
            pending.push({ text, anchorMsgId, chatId, chatType });
            feishuPendingQueue.set(openId, pending);
            feishuLog(`[FeishuConcurrent] at capacity (${forkCount + 1}/${FEISHU_MAX_CONCURRENT}), queued for openId=...${openId.slice(-6)}`);
            if (anchorMsgId && feishuTokenManager) {
              addProcessingReaction(anchorMsgId, feishuTokenManager).catch(() => {});
            }
          }
        } else {
          // Phase E: flush any completed fork Q/As into base PM before new message,
          // so the new message's context already contains all concurrent work done so far.
          flushForkBufferToBase(openId, existingPmId);
          feishuBusy.add(existingPmId);
          feishuReplyTarget.set(existingPmId, rt);
          startTask(existingPmId, rt, anchorMsgId);
          userMessage(existingPmId, text);
          killedAgents.delete(existingPmId);
          markPendingInput(existingPmId);
          feishuLog(`[feishu-pm-inject] existing session → PM ${existingPmId} text="${text.slice(0, 120)}" (len=${text.length})`);
          a.receiveUserInput(text, anchorMsgId || undefined);
        }
      } else {
        feishuLog(`[FeishuBridge] PM ${existingPmId} gone, starting fresh`);
        feishuAggregators.get(existingPmId)?.reset();
        feishuAggregators.delete(existingPmId);
        feishuSessions.delete(openId);
        inputMgr.clear(openId); // discard any stale pending window for this user
        setImmediate(() => {
          const newPmId = `feishu-${crypto.createHash("sha256").update(openId + Date.now()).digest("hex").slice(0, 8)}`;
          feishuSessions.set(openId, newPmId);
          feishuReplyTarget.set(newPmId, rt);
          startTask(newPmId, rt, anchorMsgId);
          ensureAgent({ id: newPmId, name: `飞书:${openId.slice(-4)}`, role: "Leader", state: "idle",
            sub: "飞书会话", model: leaderProviderCfg.model });
          feishuAggregators.set(newPmId, createAggregator(newPmId));
          userMessage(newPmId, text);
          startLeaderAgent({ id: newPmId, firstMessage: text, inputId: anchorMsgId || undefined, promptFile: "pm",
            conversationMode: true, replyHook: makeGatewayHook(newPmId),
            turnEndHook: () => {
              feishuBusy.delete(newPmId);
              shadowCompleteBase(openId, newPmId);
              const bpm2 = agents.get(newPmId);
              if (bpm2 instanceof HttpConvAgent) {
                let cleanHistory2 = bpm2.getMessages();
                const buf2 = feishuForkBuffer.get(openId);
                if (buf2 && buf2.length > 0) {
                  buf2.sort((a, b) => a.seq - b.seq);
                  const forkEntries2 = buf2.flatMap(c => ([
                    { role: "user"      as const, content: c.question },
                    { role: "assistant" as const, content: c.answer   },
                  ]));
                  cleanHistory2 = cleanHistory2.concat(forkEntries2);
                  bpm2.appendHistory(forkEntries2);
                  feishuForkBuffer.delete(openId);
                  feishuLog(`[FeishuConcurrent] merged ${buf2.length} fork Q/As into ${newPmId} history`);
                }
                feishuCheckpoints.set(newPmId, cleanHistory2);
              }
              outboundGateway.flush(newPmId);
              drainPendingQueue(openId);
            } });
        });
      }
    }
  };

  // Input-merge window: buffers rapid consecutive messages from the same user
  // and flushes them as one combined turn after FEISHU_INPUT_WINDOW_MS of silence.
  inputMgr = new FeishuInputWindowManager(FEISHU_INPUT_WINDOW_MS, dispatchMessage);
  for (const input of sessionJournal().queued("feishu")) {
    const meta = input.metadata;
    setImmediate(() => dispatchMessage(meta.openId, input.text, input.id, meta.chatId, meta.chatType));
  }

  startFeishuWebSocket({
    appId,
    appSecret,
    onStatus: (msg: string) => {
      const connected = msg.includes("connected");
      const disconnected =
        msg.includes("closed") ||
        msg.includes("error:") ||
        msg.includes("bootstrap failed") ||
        msg.includes("max reconnect attempts reached");
      setFeishuConnection({
        enabled: true,
        connected: connected ? true : disconnected ? false : getState().feishuConnection.connected,
        status: msg,
      });
    },
    onMessage: (openId: string, text: string, chatId: string, chatType: string, messageId: string) => {
      feishuLog(
        `[FeishuBridge] onMessage openId=...${openId.slice(-6)} msgId=${messageId.slice(-8)} len=${text.length} text="${text.slice(0, 120)}"`,
      );

      // Short-time same-content guard: reject exact duplicate text within 5s per user.
      // (Event-ID dedup is already handled upstream in websocket.ts seenEventIds.)
      const recentMsg = feishuRecentTexts.get(openId);
      if (recentMsg && recentMsg.text === text && Date.now() - recentMsg.time < 5000) {
        feishuLog(`[FeishuBridge] dup content from ${openId} within 5s, skipped`);
        return;
      }
      feishuRecentTexts.set(openId, { text, time: Date.now() });

      // Feed into merge window — timer fires dispatchMessage after silence gap.
      inputMgr.feed(openId, text, messageId, chatId, chatType);
    },
  }).catch((err: unknown) => {
    feishuConnected = false; // allow retry after failure
    setFeishuConnection({
      enabled: true,
      connected: false,
      status: `连接失败: ${err instanceof Error ? err.message : String(err)}`,
    });
    feishuLog(`[FeishuWS] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// ── accessors for the few external references in AgentRuntime ────────────────
export function isFeishuConnected(): boolean { return feishuConnected; }
export function feishuSessionCount(): number { return feishuSessions.size; }
export function getFeishuTokenManager(): TokenManager | null { return feishuTokenManager; }
export { feishuMsgQueue, feishuReplyTarget, feishuForks, feishuBridge };
