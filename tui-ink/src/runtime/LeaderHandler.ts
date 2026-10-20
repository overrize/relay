import { resolveModelRoute } from "../models/routing.js";
import { sessionJournal } from "../session/Journal.js";
import { registerSessionAgent, beginSessionRecovery } from "../session/Control.js";
import { registerRuntimeOwner } from "../session/RuntimeOwner.js";
import { taskNotice } from "./TaskNotice.js";
import { admitWorker } from "../session/Tasks.js";
import { recoverTasks } from "./TaskRecovery.js";
import { cancelAgentToolsAndWait } from "../tools/command.js";
/** LeaderHandler — startLeaderAgent (spawn-1.0 M1-6e). golden 25 covers it. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { HttpConvAgent } from "../adapters/httpAgent.js";
import type { ProcessManager } from "../pm/ProcessManager.js";
import type { TuiEvent } from "../protocol.js";
import type { LeaderOpts } from "./AgentRuntime.js";
import {
  applyEvent, ensureAgent, getState, selectAgent, userMessage,
  updateAgentInfo, markPendingInput, resumeAgent, abortAgent, setPendingRating,
} from "../store.js";
import { loadConfig, getAgentProviderConfig } from "../config.js";
import {
  SecretaryProxy, createMemory, loadMemory, loadMemoryByHash, listUnfinishedAgents,
  deleteAgentMemory, topFactsByWeight, loadSessions, initSecretary, destroySecretary, buildResumeContext,
} from "./MemoryRuntime.js";
import { executeTool, toolNeedsApproval, buildToolSchemaBlock, runToolBatch, formatToolResults, findApproverLeader } from "./ToolRuntime.js";
import type { AgentRole } from "./ToolRuntime.js";
import { ConversationRuntime, TurnController, classifyFollowup, isStatusQuery, checkMessageLegal } from "./OrchestratorRuntime.js";
import { feishuMsgQueue, feishuReplyTarget, feishuBridge, getFeishuTokenManager } from "./FeishuBridge.js";
import { createTask, createCardRenderer } from "../feishu/card-renderer.js";
import { sendTextMessage, addProcessingReaction, deleteProcessingReaction, patchCardMessage, replyToMessageWithText } from "../feishu/message.js";
import { taskRegistry, cardIndex, pmCurrentTask } from "../feishu/session.js";
import { feishuLog } from "../feishu/debug.js";
import { globalBus } from "../bus/Bus.js";
import { recordHealthMetric, logDiag } from "./ObservabilityRuntime.js";
import { runDemo } from "./DevHarness.js";

import { getHandlerDeps } from "./HandlerContext.js";
import { startWorker } from "./WorkerHandler.js";

export function startLeaderAgent(opts: LeaderOpts): void {
  const { agents, killedAgents, pm, feishuBusy, secretaries, pmPendingArtifacts, leaderApprovalQueue, buildSystemPrompt, killAgent, MODEL, DEMO } = getHandlerDeps();
  if (DEMO && !opts.parentId) { return runDemo(opts.firstMessage ?? "demo", { agents, MODEL }); }
  if (agents.has(opts.id)) {
    logDiag(`[startLeaderAgent] EARLY RETURN: agents already has "${opts.id}" — skipping spawn\n`);
    return;
  }

  const cfg = loadConfig();
  let modelRoute;
  try { modelRoute = resolveModelRoute(cfg,"leader",opts.parentId ? "leader" : "pm",opts.model); }
  catch(error) { applyEvent({v:1,type:"agent.error",agent:opts.id,code:"model_route",detail:String(error)}); return; }
  const leaderProviderCfg = modelRoute.candidates[0]!.config;
  const model = leaderProviderCfg.model ?? MODEL;
  const isRoot = !opts.parentId;
  const promptFile = opts.promptFile ?? (isRoot ? "pm" : "leader");

  // Compute depth and parent chain from store when not provided
  const depth = opts.depth ?? (() => {
    if (isRoot) return 0;
    let d = 0; let cur = opts.parentId!;
    for (let i = 0; i < 10; i++) {
      const info = getState().agents.get(cur);
      if (!info?.parent) break; d++; cur = info.parent;
    }
    return d + 1;
  })();

  const parentChain: string[] = opts.parentChain ?? (() => {
    if (isRoot) return [];
    const chain: string[] = [];
    let cur = opts.parentId!;
    for (let i = 0; i < 10; i++) {
      chain.unshift(cur);
      const info = getState().agents.get(cur);
      if (!info?.parent) break;
      cur = info.parent;
    }
    return chain;
  })();

  // Phase B: forked tasks share the exact system prompt from the base PM for Anthropic cache reuse.
  const systemPrompt = opts.sharedSystemPrompt
    ?? buildSystemPrompt("Leader", opts.id, opts.goal, opts.resumedMemoryId, promptFile);
  const journal = sessionJournal();
  if (isRoot) registerRuntimeOwner();
  const existed = journal.binding(opts.id);
  journal.bind(opts.id, "Leader", opts.parentId, opts.goal ?? "", opts.dispatch);
  if (isRoot) beginSessionRecovery(journal.binding(opts.id)!.conversation);
  if (existed && isRoot) journal.append("session.recovered", existed.conversation, opts.id, journal.currentRevision(opts.id)!, {});
  const a = new HttpConvAgent({
    id: opts.id,
    role: "Leader",
    sessionManaged: true,
    providerCfg: { ...leaderProviderCfg, model },
    modelCandidates: modelRoute.candidates, routingProfile: modelRoute.profile,
    systemPrompt,
    resumeFrom: opts.isForkedTask ? undefined : opts.resumedMemoryId,
    initialMessages: opts.initialMessages,
  });
  const unregisterSession = registerSessionAgent(opts.id, () => {
    if (opts.parentId) { killAgent(opts.id, "superseded requirement"); updateAgentInfo(opts.id, { state: "err", sub: "superseded" }); }
    else { a.kill(); abortAgent(opts.id); toolQueue.length = 0; }
  });
  agents.set(opts.id, a);
  globalBus.registerAgent(opts.id, a);

  // Every conversation, including concurrent forks, has a durable secretary.
  const secretary: SecretaryProxy = initSecretary(
    secretaries, opts.id, opts.resumedMemoryId,
    () => ({
      agentId: opts.id,
      agentType: isRoot ? "PM" : "LEADER",
      parentChain,
      depth,
      model,
      roleName: isRoot ? "PM" : "Leader",
      dispatch: opts.dispatch ?? {
        background: opts.goal ?? (isRoot ? "Root PM orchestrator" : "Leader orchestrator"),
        constraints: [],
        acceptance_criteria: [],
        stop_conditions: ["user.quit"],
      },
    }),
  );

  secretary.once("destroy", unregisterSession);

  // Per-turn state
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let actedThisTurn = false;
  let continuations = 0;
  let gaveUp = false;
  let nudgePending = false; // true when the next run turn is a system-initiated nudge
  let sentToUserThisTurn = false; // true when PM sent message.to=user this turn
  let reportedToParent = false;   // true when TL/Worker sent message to their parent this turn
  let lastToolCallKey = "";       // loop detection: last "tool:argsJSON" key
  let sameToolCallCount = 0;      // how many consecutive times same tool+args was called
  let terminalEventAccepted = false; // non-root leaders/forks ignore delayed events after agent.done
  let outstandingTools = 0;
  let finishingFailure = false;
  const turnShadow = new TurnController();
  const logTurnShadow = (): void => {
    if (process.env.SPAWN_SHADOW_TURN !== "1") return;
    logDiag(`[TurnController:shadow] ${opts.id} ${JSON.stringify(turnShadow.snapshot())}\n`);
  };

  // Quality tracking — emitted as structured stderr log on agent.done
  let qualTurns = 0;
  let qualNudges = 0;
  let qualHandup = false;
  let lastTtftMs = 0;
  let lastTotalMs = 0;

  // Unified child-Leader convergence (Feishu 已读不回 / 已读空回 fix).
  // A non-conversation sub-Leader (TL) can pass through MANY idle exits without ever
  // converging (1307 replied-no-todos, 1346 auto-close, 1362/1408 gaveUp, fall-throughs),
  // leaving store.state="idle" forever → parent PM waits indefinitely → feishuBusy never
  // releases → pending Feishu messages never drain. Rather than patch each exit, the idle
  // handler's terminal/no-op exits "make way" for sub-Leaders (guard: convMode || !parentId)
  // and route them all to ONE of three dead-zone fallbacks, which call this single function.
  // Contract: relay TL's real output to parent FIRST (so PM has content to tell the user,
  // not 已读空回), THEN synthesize agent.done so the existing done pipeline runs (store→done
  // clears PM activeChildren, completeForeground + parent-notify + unregister via a.emit).
  const convergeChildLeader = (reasonTag: string, conv: { gaveUp?: boolean } = {}): void => {
    const parentId = opts.parentId!;
    let report: string;
    if (conv.gaveUp) {
      // Gave-up path: stale prose is misleading — relay an explicit "abandoned" notice.
      report = `[${opts.id} 汇报] 多次推进无效，已放弃该子任务。请基于已有上下文向用户说明当前进展。`;
    } else {
      // Pick the most recent CLEAN assistant prose: not empty, not raw protocol JSON,
      // and not DeepSeek DSML tool-call noise (relaying DSML markup is worse than a placeholder).
      const lastProse = [...a.getMessages()].reverse().find((m) => {
        const t = m.content.trim();
        return m.role === "assistant" && t !== "" &&
          !t.startsWith("{") && !t.startsWith("<") && !m.content.includes("｜｜DSML｜｜");
      })?.content.trim() ?? "";
      report = lastProse
        ? `[${opts.id} 汇报] ${lastProse.slice(0, 1500)}`
        : `[${opts.id} 汇报] 子任务已完成，TL 未生成有效汇总。请基于已有上下文向用户说明当前进展。`;
    }
    logDiag(`[${opts.id}] idle → child-leader converge [${reasonTag}] relay+done (gaveUp=${!!conv.gaveUp})\n`);
    const parentAgent = agents.get(parentId);
    if (parentAgent instanceof HttpConvAgent && !killedAgents.has(parentId)) {
      parentAgent.sendCommand({ type: "user.message", text: report });
      reportedToParent = true;
    }
    a.emit("event", {
      v: 1, type: "agent.done", agent: opts.id, success: true, reason: reasonTag,
    } as TuiEvent);
  };

  // Drain a conversation-mode PM after it has replied to the user: release the serial
  // feishuBusy lock and dispatch the next queued follow-up. Shared by the clean-exit path
  // (replied + no todos) and the dead-zone path (replied + stale todos + nudges exhausted).
  // Without the dead-zone caller, a PM that spawned a TL holds feishuBusy forever after its
  // first reply — every later follow-up ("结论呢"…) queues but never drains (only-replies-once bug).
  const drainConvModePM = (closeStaleTodos: boolean): void => {
    if (closeStaleTodos) {
      const todos = getState().todosByAgent.get(opts.id) ?? [];
      if (todos.some((t) => t.state === "todo" || t.state === "run")) {
        const closed = todos.map((t) => ({ ...t, state: (t.state === "todo" || t.state === "run") ? "done" : t.state }));
        applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
      }
    }
    opts.turnEndHook?.();
    feishuBusy.delete(opts.id);
    const nextItem = feishuMsgQueue.get(opts.id)?.shift();
    if (nextItem) {
      const { text: nextMsg, messageId: nextMsgId } = nextItem;
      logDiag(`[${opts.id}] delivering queued msg: "${nextMsg.slice(0, 60)}"\n`);
      feishuBusy.add(opts.id);
      const rt = feishuReplyTarget.get(opts.id);
      const tm = getFeishuTokenManager();
      if (rt && tm) {
        const task = createTask({ pmId: opts.id, ...rt, rootMessageId: nextMsgId }, tm);
        taskRegistry.set(task.taskId, task);
        pmCurrentTask.set(opts.id, task.taskId);
        feishuBridge.emit({ type: 'task_spawned', taskId: task.taskId, agentPath: 'PM', title: '🦞 PM' });
        if (nextMsgId) {
          addProcessingReaction(nextMsgId, tm)
            .then((rid) => { task.reactionId = rid; })
            .catch(() => {});
        }
      }
      setImmediate(() => {
        if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
        userMessage(opts.id, nextMsg);
        a.sendCommand({ type: "user.message", text: nextMsg });
      });
    }
  };

  a.on("event", (e: TuiEvent) => {
    if (finishingFailure && e.type !== "token.usage") return;
    if (e.type === "agent.done" && e.success && (toolQueue.length || outstandingTools || [...getState().agents.values()].some((child) => child.parent === opts.id && child.state !== "done" && child.state !== "err"))) return;
    if (e.type === "agent.done" && !e.success && outstandingTools) {
      finishingFailure = true; toolQueue.length = 0;
      void cancelAgentToolsAndWait(opts.id).then(() => { outstandingTools = 0; finishingFailure = false; a.emit("event", e); }); return;
    }
    if (terminalEventAccepted && e.type !== "token.usage") {
      logDiag(`[${opts.id}] dropped ${e.type} after terminal agent.done\n`);
      return;
    }

    // Spawn — pre-check then dispatch to correct handler
    if (e.type === "spawn") {
      // Guard 1: reject before store write if the child ID already exists.
      // LLMs sometimes hallucinate reusing an existing agent ID (e.g. spawning the PM
      // itself as a worker), which would corrupt the store entry and stall the parent.
      if (agents.has(e.child)) {
        logDiag(`[${opts.id}] spawn REJECTED: child="${e.child}" already exists in agents Map\n`);
        a.sendCommand({ type: "user.message", text: `[系统] spawn 失败：agent ID "${e.child}" 已被占用。请使用一个唯一的新 ID（如 worker-${Date.now().toString(36).slice(-4)}）。` });
        return;
      }
      // Guard 2: normalize parent to opts.id — LLM sometimes outputs a stale/wrong parent
      // (e.g. "pm" when the actual Feishu PM ID is "feishu-xxxxxxxx"). If we leave it as-is,
      // the child's parent field in the store won't match opts.id and activeChildren = 0.
      const normalized: typeof e = e.parent !== opts.id ? { ...e, parent: opts.id } : e;
      // Use opts.id (not e.parent) for role lookup — e.parent may be stale
      const parentRole = getState().agents.get(opts.id)?.role;
      const check = pm.preCheckSpawn(normalized, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: opts.id, code: check.code, detail: check.detail });
        return;
      }
      try { admitWorker(normalized); }
      catch (error) { a.sendCommand({ type: "user.message", text: `[任务控制] 派工被拒绝：${String(error)}。请用 TaskStatus 检查，不得换 ID 重置预算。` }); return; }
      actedThisTurn = true;
      turnShadow.markAction();
      applyEvent(normalized);
      pm.observe(normalized);
      logDiag(`[${opts.id}] spawn child=${normalized.child} role=${normalized.role ?? "?"} goal="${(normalized.goal ?? "").slice(0, 80)}"\n`);
      startWorker(normalized); // foreground tracking registered inside startWorker for both Leader+Worker
      return;
    }

    if (e.type === "agent.error") {
      applyEvent(e); pm.observe(e);
      if (opts.parentId && (e.code === "http_error" || e.code === "context_error" || e.code === "session_budget")) a.emit("event", { v: 1, type: "agent.done", agent: opts.id, success: false, reason: `model-request-failed: ${e.code}`, session_revision: e.session_revision });
      return;
    }

    // PM can kill a child agent via protocol — same effect as ESC on that pane
    if (e.type === "agent.kill") {
      const targetState = getState().agents.get(e.target)?.state;
      if (targetState === "run" || targetState === "idle") {
        killAgent(e.target, e.reason ?? "killed by parent");
        applyEvent({ v: 1, type: "message", agent: opts.id, to: "user",
          text: `⏹ ${opts.id} killed ${e.target}${e.reason ? ": " + e.reason : ""}` });
      }
      return;
    }

    if (e.type === "message" && !checkMessageLegal(e, { getState, applyEvent, pm })) return;

    // Non-root leaders/TLs do not own the Feishu/user reply channel. If a TL
    // writes message.to=user, relay it to its parent PM instead so the final
    // artifact is not lost behind the OutboundGateway's active-child filter.
    if (e.type === "message" && opts.parentId && e.to === "user") {
      const redirected = { ...e, to: opts.parentId } as typeof e;
      logDiag(`[${opts.id}] redirected message.to=user → ${opts.parentId}\n`);
      applyEvent(redirected);
      pm.observe(redirected);
      reportedToParent = true;
      turnShadow.markParentReport();
      const parentAgent = agents.get(opts.parentId);
      if (parentAgent instanceof HttpConvAgent && !killedAgents.has(opts.parentId)) {
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${opts.id}→${opts.parentId}] ${e.text}`,
        });
      }
      return;
    }

    // Approve/reject destructive Bash from a child agent
    if (e.type === "tool.approved" || e.type === "tool.rejected") {
      const pending = leaderApprovalQueue.get(e.id);
      if (pending) {
        leaderApprovalQueue.delete(e.id);
        if (e.type === "tool.approved") {
          executeTool(pending.toolName, pending.toolArgs, { agentId: pending.workerChildId, revision: pending.revision }).then((r) => {
            if (!sessionJournal().isCurrent(pending.workerChildId, pending.revision)) return;
            if (getState().agents.get(pending.workerChildId)?.state === "done" || killedAgents.has(pending.workerChildId)) {
              logDiag(`[${pending.workerChildId}] dropped Bash-approval tool.result — agent done during execution\n`);
              return;
            }
            applyEvent({ v: 1, type: "tool.result", agent: pending.workerChildId, id: e.id, ok: r.ok, output: r.output });
            pending.workerAgent.sendCommand({ type: "tool.result", id: e.id, ok: r.ok, output: r.output });
          });
        } else {
          const reason = e.reason ?? "leader rejected";
          applyEvent({ v: 1, type: "tool.result", agent: pending.workerChildId, id: e.id, ok: false, output: `Rejected: ${reason}` });
          pending.workerAgent.sendCommand({ type: "tool.result", id: e.id, ok: false, output: `Rejected: ${reason}` });
        }
      }
      return;
    }

    applyEvent(e);
    pm.observe(e);

    // ── per-event debug logging ──────────────────────────────────────────────
    if (e.type === "agent.state") {
      logDiag(`[${opts.id}] state→${e.state} acted=${actedThisTurn} sentUser=${sentToUserThisTurn} reportedParent=${reportedToParent} cont=${continuations} gaveUp=${gaveUp}\n`);
    }
    if (e.type === "message") {
      logDiag(`[${opts.id}] message to=${e.to} "${e.text.slice(0, 120)}"\n`);
    }
    if (e.type === "todo.set") {
      // M1-7 (BC-001): a plan-only turn is NOT an action. Emitting todo.set
      // without a tool.call/spawn/message/done leaves actedThisTurn=false so
      // the idle handler routes to the "强制执行" nudge instead of the softer
      // "acted-but-todo-pending" one. This unifies leader with worker (whose
      // workerActedThisTurn is already not set by todo.set) — "催了才干活" fix.
      const summary = (e.items as Array<{state: string; text: string}>).map((t) => `[${t.state}]${t.text.slice(0,30)}`).join(", ");
      logDiag(`[${opts.id}] todo.set ${e.items.length} items: ${summary}\n`);
    }
    if (e.type === "tool.call") {
      logDiag(`[${opts.id}] tool.call ${e.name}(${JSON.stringify(e.args).slice(0, 100)})\n`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (e.type === "agent.state" && e.state === "run") {
      turnShadow.beginTurn();
      actedThisTurn = false;
      sentToUserThisTurn = false;
      reportedToParent = false;
      lastToolCallKey = "";
      sameToolCallCount = 0;
      if (!nudgePending) { continuations = 0; gaveUp = false; }
      else qualNudges++; // nudgePending=true means this run was system-initiated
      nudgePending = false;
      qualTurns++;
    }

    if (e.type === "tool.call") {
      actedThisTurn = true;
      turnShadow.markAction();
      const toolKey = `${e.name}:${JSON.stringify(e.args)}`;
      if (toolKey === lastToolCallKey) { sameToolCallCount++; } else { lastToolCallKey = toolKey; sameToolCallCount = 1; }
      if (!toolNeedsApproval(e.name, e.args as Record<string, unknown>)) {
        toolQueue.push(e);
      } else if (opts.conversationMode) {
        // Feishu/conversation mode: PM is the authority — auto-approve destructive tools.
        // No human is watching the TUI to click y/n.
        logDiag(`[${opts.id}] auto-approve tool "${e.name}" (conversationMode)\n`);
        toolQueue.push(e);
      } else if (!opts.parentId) {
        // Root PM in normal mode has no parent to approve — return error so agent can recover.
        setImmediate(() => {
          applyEvent({ v: 1, type: "tool.result", agent: opts.id, id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
          a.sendCommand({ type: "tool.result", id: e.id, ok: false,
            output: `Tool "${e.name}" requires approval. Root leader has no parent to approve — use a non-destructive alternative or rephrase the command.` });
        });
      }
      // else: non-root leader routes to parent via leaderApprovalQueue (handled below)
    }

    if (e.type === "message") {
      actedThisTurn = true;
      if (e.to === "user") {
        sentToUserThisTurn = true;
        turnShadow.markUserReply();
        // All suppression, format, and sanitization decisions are centralised in the
        // OutboundGateway. Pass _fallback through so SuppressFilter can catch it.
        opts.replyHook?.(e.text, e.format, { _fallback: (e as any)._fallback, agentId: e.agent });
      }
      if (opts.parentId && e.to === opts.parentId) {
        reportedToParent = true;
        turnShadow.markParentReport();
        // Extract any file paths TL reported to PM so they can be injected at PM's turnEnd.
        const pathMatches = e.text.match(
          /(?:[A-Za-z]:[\\/]|\/|\.\/)(?:[^\s,，。）\]"'\n\\]+)\.(?:md|txt|json|csv|yaml|yml)/gi,
        );
        if (pathMatches?.length) {
          const pending = pmPendingArtifacts.get(opts.parentId) ?? [];
          for (const p of pathMatches) pending.push(p);
          pmPendingArtifacts.set(opts.parentId, pending);
          logDiag(`[${opts.id}] artifact paths captured for ${opts.parentId}: ${pathMatches.join(", ")}\n`);
        }
      }
      if (e.to !== "user" && (!opts.parentId || e.to !== opts.parentId)) {
        turnShadow.markAction();
      }
      if (e.to !== "user") {
        const routed = globalBus.routeMessage(opts.id, e.to, e.text);
        if (!routed) {
          a.sendCommand({
            type: "user.message",
            text: `[系统] 消息无法送达：agent "${e.to}" 不存在或已结束。请重新 spawn，或 message→user 说明情况。`,
          });
        }
      }
    }

    if (e.type === "token.usage") {
      if (e.ttft_ms !== undefined) lastTtftMs = e.ttft_ms;
      if (e.total_ms !== undefined) lastTotalMs = e.total_ms;
    }

    if (e.type === "agent.done") {
      actedThisTurn = true;
      turnShadow.markAction();
      if (opts.parentId || opts.isForkedTask) {
        terminalEventAccepted = true;
        toolQueue.length = 0;
      }
      if (!opts.isForkedTask) {
        const tok = getState().tokensByAgent.get(opts.id);
        const rejects = (getState().messagesByAgent.get(opts.id) ?? [])
          .filter((m) => m.kind === "tool_result" && m.text.startsWith("Tool rejected")).length;
        const score = Math.max(0, Math.min(100,
          100
          - qualNudges * 8
          - (gaveUp ? 25 : 0)
          - (qualHandup ? 15 : 0)
          - (e.success ? 0 : 20)
          - rejects * 10
          + (e.evidence?.length ? 10 : 0)
          + (qualNudges === 0 ? 10 : 0)
        ));
        const sessionHash = secretary?.getMemory()?.session_hash ?? "?";
        logDiag(
          `[quality] ${opts.id} session=${sessionHash} score=${score}` +
          ` success=${e.success} turns=${qualTurns} nudges=${qualNudges}` +
          ` handup=${qualHandup} gaveUp=${gaveUp} rejects=${rejects}` +
          ` tokens_in=${tok?.prompt ?? 0} tokens_out=${tok?.completion ?? 0}` +
          ` evidence=${e.evidence?.length ?? 0}` +
          ` latency=${opts.id}:${lastTtftMs}/${lastTotalMs}\n`,
        );
        if (!opts.parentId) setPendingRating(opts.id, sessionHash);
      } else {
        // Forked task done — clean up bus registration (no memory to delete).
        globalBus.unregisterAgent(opts.id);
      }
    }
    // Tech Lead completion — notify parent PM + ingest memory upward
    if (e.type === "agent.done" && opts.parentId) {
      const pmSec = secretaries.get(opts.parentId);
      if (pmSec && secretary) pmSec.ingestChildMemory(secretary.getMemory() as any);
      // Resolve foreground tracking so parent's pm.getForegroundChildren() reflects completion
      pm.completeForeground(opts.id, { success: e.success, reason: e.reason, evidence: e.evidence });
        if (e.success) {
          const evidenceLines = e.evidence?.length
            ? "\n证据:\n" + e.evidence.map((s) => `  - ${s}`).join("\n") : "";
          taskNotice(opts.parentId, opts.id, `[系统] ${opts.id} 自报完成${e.reason ? ": " + e.reason : ""}。${evidenceLines}\n请核对验收证据并继续推进任务。`, agents, killedAgents);
        } else {
          taskNotice(opts.parentId, opts.id, `[系统-失败] ${opts.id} 任务停止${e.reason ? ": " + e.reason : ""}。依据持久交接决定补充上下文、续派或换策略；仅在确需用户决策时询问。`, agents, killedAgents);
        }
      globalBus.unregisterAgent(opts.id);
      // Stop the secretary while retaining the completed snapshot for resume.
      destroySecretary(secretaries, opts.id); // Keep completed snapshots available for resume.
      a.kill();
    }

    if (e.type === "unit.handup") {
      qualHandup = true;
      turnShadow.markParentReport();
    }

    // unit.handup — forward to parent
    if (e.type === "unit.handup" && opts.parentId) {
      // Capture artifact paths for PM's forced document injection at turnEnd.
      if (e.artifacts?.length) {
        const pending = pmPendingArtifacts.get(opts.parentId) ?? [];
        for (const p of e.artifacts) pending.push(p);
        pmPendingArtifacts.set(opts.parentId, pending);
        logDiag(`[${opts.id}] handup artifacts captured for ${opts.parentId}: ${e.artifacts.join(", ")}\n`);
      }
      const parentAgent = agents.get(opts.parentId);
      if (parentAgent instanceof HttpConvAgent) {
        const findingLines = e.findings?.length
          ? "\n发现:\n" + e.findings.map((f) => `  [${f.level}] ${f.text}`).join("\n") : "";
        const failedLines = e.failed_acceptance?.length
          ? "\n未达成: " + e.failed_acceptance.join("; ") : "";
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${opts.id} handup] 已完成: ${e.summary}${failedLines}${findingLines}`,
        });
      }
    }

    // Idle — drain tool queue or nudge
    if (e.type === "agent.state" && e.state === "idle") {
      if (getState().agents.get(opts.id)?.state === "done") return;
      turnShadow.endTurn();
      logTurnShadow();
      if (toolQueue.length > 0) {
        // Loop detection: warn before draining if same tool called 2+ times in a row
        if (sameToolCallCount >= 2) {
          const loopTool = lastToolCallKey.split(":")[0] ?? "";
          logDiag(`[${opts.id}] loop-detect: ${loopTool} called same args ${sameToolCallCount}x\n`);
          const warnMsg = `【系统-循环检测】你已连续 ${sameToolCallCount} 次调用相同的 ${loopTool}，得到相同结果。换一个不同的工具或不同参数，否则任务将无法推进。`;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({ type: "user.message", text: warnMsg });
          });
          sameToolCallCount = 0;
        }
        const batch = toolQueue.splice(0);
        outstandingTools += batch.length;
        setImmediate(async () => {
          if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) { outstandingTools = Math.max(0, outstandingTools - batch.length); return; }
          const results = await runToolBatch(batch, opts.id);
          if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
          // Defer delivery via setImmediate so the I/O phase can drain SSE events (including
          // agent.done from the LLM stream) before we re-check and deliver. A microtask
          // continuation here would fire BEFORE pending SSE I/O, missing a concurrent agent.done.
          setImmediate(() => {
            outstandingTools = Math.max(0, outstandingTools - batch.length);
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) {
              logDiag(`[${opts.id}] dropped tool.result for ${batch.length} tool(s) — agent done during execution\n`);
              return;
            }
            for (let i = 0; i < batch.length; i++) {
              const { id } = batch[i]!;
              const { ok, output } = results[i]!;
              applyEvent({ v: 1, type: "tool.result", agent: opts.id, id, ok, output, session_revision: batch[i]!.session_revision });
            }
            // Feed combined results back to the LLM — without this the PM hangs indefinitely.
            // Use user.message so the [tool_result id=...] headers in `combined` aren't
            // double-wrapped (sendCommand type:"tool.result" would add an extra header).
            const combined = formatToolResults(batch, results);
            a.sendCommand({ type: "user.message", text: combined });
          });
        });
      } else if (actedThisTurn) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasRun = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        const activeChildren = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && ag.role !== "Secretary" && (ag.state === "run" || ag.state === "idle"));
        logDiag(`[${opts.id}] idle/acted hasTodo=${hasTodo} hasRun=${hasRun} activeChildren=${activeChildren.length} sentUser=${sentToUserThisTurn} reportedParent=${reportedToParent} convMode=${!!opts.conversationMode} cont=${continuations}\n`);
        // Belt-and-suspenders: also check foreground spawn handles (registered synchronously,
        // not subject to the spawn→run state transition race that activeChildren can miss)
        const foregroundChildren = pm.getForegroundChildren(opts.id);
        const hasActiveChildren = activeChildren.length > 0 || foregroundChildren.length > 0;
        if (hasActiveChildren) {
          logDiag(`[${opts.id}] idle → waiting for children: store=[${activeChildren.map(c => c.id).join(",")}] fg=[${foregroundChildren.join(",")}]\n`);
          // Background execution must not hold the user conversation lock.
          if (opts.conversationMode && sentToUserThisTurn) drainConvModePM(false);
        } else if (reportedToParent && !hasTodo) {
          logDiag(`[${opts.id}] idle → reportedToParent+done, closing run items\n`);
          if (hasRun) {
            const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
            applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
          }
        } else if (sentToUserThisTurn && opts.conversationMode && !hasTodo && !hasActiveChildren) {
          // Conversation mode: replied to user, no pending todos, no in-flight children → done
          logDiag(`[${opts.id}] idle → conversationMode replied+no-todos+no-children, done\n`);
          drainConvModePM(false);
        } else if (sentToUserThisTurn && opts.conversationMode && hasTodo) {
          // Conversation mode: replied to user but still has todos. (hasActiveChildren is already
          // false here — the 1297 branch caught it.) Nudge to finish; if nudges are exhausted,
          // converge anyway so the PM releases feishuBusy + drains queued follow-ups instead of
          // holding the serial lock forever (only-replies-once bug after spawning a TL).
          logDiag(`[${opts.id}] idle → conversationMode replied but hasTodo, nudging cont=${continuations}\n`);
          if (continuations < 3) {
            continuations++;
            nudgePending = true;
            const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
            setImmediate(() => {
              if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
              a.sendCommand({ type: "user.message", text: `【系统】你回复了用户但还有未完成任务：${pendingTodos}。立刻执行。` });
            });
          } else {
            // Nudges exhausted — stale meta-todos (work already delegated to a finished TL) must
            // not trap the PM. Auto-close them, release feishuBusy, dispatch next follow-up.
            logDiag(`[${opts.id}] idle → conversationMode replied + nudges exhausted, converging\n`);
            drainConvModePM(true);
          }
        } else if (sentToUserThisTurn && !hasTodo && (opts.conversationMode || !opts.parentId)) {
          // PM replied to user and has no pending tasks — done, nothing to nudge.
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          logDiag(`[${opts.id}] idle → replied+no-todos, done\n`);
        } else if (hasRun && !hasTodo && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          logDiag(`[${opts.id}] idle → hasRun+no-todo, auto-close run items\n`);
          const closed = todos.map((t) => ({ ...t, state: t.state === "run" ? "done" : t.state }));
          applyEvent({ v: 1, type: "todo.set", agent: opts.id, items: closed as any });
        } else if (hasTodo && continuations < 3) {
          continuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          logDiag(`[${opts.id}] idle → nudge cont=${continuations} pending="${pendingTodos.slice(0,80)}"\n`);
          nudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: `【系统】todo 未完成：${pendingTodos}。立刻执行下一步（tool.call 或 spawn 或直接回答）。`,
            });
          });
        } else if (hasTodo && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the dead-zone fallback below.
          logDiag(`[${opts.id}] idle → gaveUp after 3 nudges\n`);
          gaveUp = true;
          const pendingTodos = todos.filter((t) => t.state === "todo").map((t) => t.text).join("; ");
          applyEvent({
            v: 1, type: "message", agent: opts.id, to: "user",
            text: `⚠ ${opts.id} 回复后 3 次推进仍停滞。未完成项：${pendingTodos}。\n请选择：① 重试  ② 换策略  ③ 放弃`,
          });
        } else if (!hasRun && !hasTodo && continuations < 3) {
          // Agent replied (e.g. after resume) but emitted no todo.set and has no children.
          // Without a todo list the system has no signal to nudge — force one.
          continuations++;
          nudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: `【系统】你回复了但没有输出 todo.set。立刻输出 todo.set 列出当前计划，然后执行第一步。`,
            });
          });
        } else if (opts.conversationMode) {
          // Defensive fall-through: acted (spawn/tool/message) but no branch above matched.
          // This happens when PM spawned a TL that died before completing, or exhausted nudges
          // without ever sending a user reply. Release the serial queue to prevent deadlock.
          logDiag(`[${opts.id}] idle → actedThisTurn+conversationMode+no-branch-matched, releasing feishuBusy\n`);
          opts.turnEndHook?.();
          feishuBusy.delete(opts.id);
        } else if (!opts.conversationMode && opts.parentId && !hasActiveChildren && !reportedToParent) {
          // Child-Leader dead-zone fallback (link A — acted). Any sub-Leader that acted but was
          // not converged by a specific exit above (made-way 1307/1346/1362, or fell through)
          // lands here. !hasActiveChildren protects a TL still waiting on a worker; !reportedToParent
          // skips those already handled by the reportedToParent exit.
          convergeChildLeader("idle-acted-deadzone");
        }
      } else if (!actedThisTurn && !gaveUp) {
        const todos = getState().todosByAgent.get(opts.id) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        const activeChildren2 = Array.from(getState().agents.values())
          .filter((ag) => ag.parent === opts.id && ag.role !== "Secretary" && (ag.state === "run" || ag.state === "idle"));
        logDiag(`[${opts.id}] idle/no-action hasPending=${hasPending} activeChildren=${activeChildren2.length} cont=${continuations}\n`);
        if (hasPending && activeChildren2.length > 0) {
          logDiag(`[${opts.id}] idle → waiting for children: ${activeChildren2.map(c => c.id).join(",")}\n`);
        } else if (hasPending && continuations < 3) {
          continuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo" || t.state === "run").map((t) => t.text).join("; ");
          logDiag(`[${opts.id}] idle → nudge(no-action) cont=${continuations} pending="${pendingTodos.slice(0,80)}"\n`);
          nudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            const pending2 = todos.filter((t: {state:string;text:string}) => t.state === "todo" || t.state === "run").map((t: {text:string}) => t.text).join("; ");
            a.sendCommand({ type: "user.message", text: `【系统-强制执行】你已经规划了 todo 但没有采取任何行动。现在必须立刻输出以下之一：\n1. spawn 指令（如果需要 TL 执行）\n2. tool.call 指令（如果 PM 自己能处理）\n3. message.to=user（如果可以直接回答）\n未完成项：${pending2}\n不允许再次只输出 todo.set 或 step。` });
          });
        } else if (hasPending && (opts.conversationMode || !opts.parentId)) {
          // Make-way guard: sub-Leaders fall through to the link-B dead-zone fallback below.
          gaveUp = true;
          const pendingTodos = todos.filter((t) => t.state === "todo" || t.state === "run").map((t) => t.text).join("; ");
          if (opts.parentId) {
            const parentAgent = agents.get(opts.parentId);
            if (parentAgent instanceof HttpConvAgent) {
              parentAgent.sendCommand({
                type: "user.message",
                text: `[系统-卡住] ${opts.id} 经过 3 次推进仍无有效行动。未完成项：${pendingTodos}。\n请立即 message→user 说明情况。`,
              });
            }
          } else {
            applyEvent({
              v: 1, type: "message", agent: opts.id, to: "user",
              text: `⚠ ${opts.id} 经过 3 次推进仍无有效行动。未完成项：${pendingTodos}。\n请选择：\n① 重试 — 输入新指令\n② 换策略 — 描述新方法\n③ 放弃 — 结束当前任务`,
            });
          }
        } else if (continuations < 2) {
          // PM processed a message but produced no output (no message, tool.call, or spawn)
          // and has no pending todos. Nudge it to actually reply.
          continuations++;
          nudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(opts.id, e.session_revision)) return;
            if (getState().agents.get(opts.id)?.state === "done" || killedAgents.has(opts.id)) return;
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你刚才处理了消息但没有输出任何内容（无 message、无 tool.call、无 spawn）。请立刻 message→user 回复用户，或说明你在等待什么。",
            });
          });
        } else if (!opts.conversationMode && opts.parentId && activeChildren2.length === 0 && pm.getForegroundChildren(opts.id).length === 0 && !reportedToParent) {
          // Child-Leader dead-zone fallback (link B — no action). Sub-Leader took no action,
          // nudges exhausted (or no pending work), no active children, never reported — converge.
          convergeChildLeader("idle-noaction-deadzone");
        } else {
          continuations = 0;
        }
      } else if (!opts.conversationMode && opts.parentId && !reportedToParent) {
        // Top-level dead-zone fallback: a sub-Leader with actedThisTurn=false && gaveUp=true
        // falls through BOTH chains above (acted chain and !acted&&!gaveUp chain). Converge it
        // with gave-up semantics (relay an explicit "abandoned" notice, not stale prose).
        const hasKids = Array.from(getState().agents.values())
          .some((ag) => ag.parent === opts.id && ag.role !== "Secretary" && (ag.state === "run" || ag.state === "idle"))
          || pm.getForegroundChildren(opts.id).length > 0;
        if (!hasKids) convergeChildLeader("gaveup-deadzone", { gaveUp: true });
      }
    }
  });

  secretary?.on("event", (e: TuiEvent) => applyEvent(e));

  a.on("_raw_message", (m: { role: "user" | "assistant"; content: string }) => {
    secretary?.observeMessage(m.role, m.content);
  });

  // Set depth in store for non-root leaders
  if (!isRoot) {
    updateAgentInfo(opts.id, { depth, model });
  }

  // Build and send initial message
  let initMsg = opts.firstMessage;
  if (!initMsg) {
    if (opts.goal && opts.dispatch) {
      const parts: string[] = [`任务目标：${opts.goal}`];
      if (opts.dispatch.background) parts.push(`背景：${opts.dispatch.background}`);
      if (opts.dispatch.constraints?.length) parts.push(`约束：${opts.dispatch.constraints.join("；")}`);
      if (opts.dispatch.acceptance_criteria?.length) parts.push(`验收标准：${opts.dispatch.acceptance_criteria.join("；")}`);
      initMsg = parts.join("\n");
    } else {
      initMsg = opts.goal ?? "等待用户指令";
    }
  }
  if (opts.resumedMemoryId) a.resumeSession();
  else if (isRoot) a.receiveUserInput(initMsg, opts.inputId);
  else a.sendCommand({ type: "user.message", text: initMsg });
  if (isRoot) setImmediate(() => { if (agents.get(opts.id) === a && !killedAgents.has(opts.id)) recoverTasks(journal.binding(opts.id)!.conversation); });
}
