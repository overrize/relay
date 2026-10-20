import { resolveModelRoute } from "../models/routing.js";
import { sessionJournal } from "../session/Journal.js";
import { registerSessionAgent, waitForSessionControl } from "../session/Control.js";
import { taskNotice } from "./TaskNotice.js";
import { consumeTaskTurn, taskFor } from "../session/Tasks.js";
import { prepareWorkspace } from "../session/Workspaces.js";
import { cancelAgentToolsAndWait } from "../tools/command.js";
/** WorkerHandler — startWorker (spawn-1.0 M1-6e). golden 25 covers it. */
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
import { ConversationRuntime, TurnController, classifyFollowup, isStatusQuery, checkMessageLegal, decideDoneGuard } from "./OrchestratorRuntime.js";
import { feishuMsgQueue, feishuReplyTarget, feishuBridge, getFeishuTokenManager } from "./FeishuBridge.js";
import { createTask, createCardRenderer } from "../feishu/card-renderer.js";
import { sendTextMessage, addProcessingReaction, deleteProcessingReaction, patchCardMessage, replyToMessageWithText } from "../feishu/message.js";
import { taskRegistry, cardIndex, pmCurrentTask } from "../feishu/session.js";
import { feishuLog } from "../feishu/debug.js";
import { globalBus } from "../bus/Bus.js";
import { recordHealthMetric, logDiag } from "./ObservabilityRuntime.js";
import { runDemo } from "./DevHarness.js";

import { getHandlerDeps } from "./HandlerContext.js";
import { startLeaderAgent } from "./LeaderHandler.js";

export function startWorker(
  e: Extract<TuiEvent, { type: "spawn" }>,
  opts: { resumedMemoryId?: string; firstMessage?: string } = {},
): void {
  const { agents, killedAgents, pm, feishuBusy, secretaries, pmPendingArtifacts, leaderApprovalQueue, buildSystemPrompt, killAgent, MODEL, DEMO } = getHandlerDeps();
  if (agents.has(e.child)) return;

  // Leader role: delegate to startLeaderAgent (Tech Lead pattern)
  if (e.role === "Leader") {
    const parentInfo = getState().agents.get(e.parent);
    const parentDepth = parentInfo?.depth ?? 0;
    const parentChain: string[] = [];
    let cur = e.parent;
    for (let i = 0; i < 10; i++) {
      parentChain.unshift(cur);
      const info = getState().agents.get(cur);
      if (!info?.parent) break;
      cur = info.parent;
    }
    startLeaderAgent({
      id: e.child,
      parentId: e.parent,
      goal: e.goal,
      // Tech Lead always uses the configured leader model — ignore whatever
      // the LLM put in the spawn JSON (models may hallucinate claude model names)
      model: undefined,
      depth: parentDepth + 1,
      parentChain,
      dispatch: e.dispatch,
      promptFile: "leader",
    });
    // Register foreground tracking for TL (same pattern as Worker below).
    // Must happen AFTER startLeaderAgent so the child is in the agents Map.
    const tlHandle = pm.registerSpawn(e.child, e.parent);
    tlHandle.promise.then((syncResult) => {
      if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
      if (syncResult === null) {
        const parentAgent = agents.get(e.parent);
        if (parentAgent instanceof HttpConvAgent) {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${e.child} 已超过 2 分钟，自动切换为后台模式。完成时会通过 task-notification 通知你。`,
          });
        }
      }
    });
    return;
  }

  const cfg = loadConfig();
  let modelRoute;
  try { modelRoute = resolveModelRoute(cfg,"worker",e.dispatch?.worker_profile ?? "implement",e.model); }
  catch(error) { applyEvent({v:1,type:"agent.error",agent:e.parent,code:"model_route",detail:String(error)}); return; }
  const baseWorkerProviderCfg = modelRoute.candidates[0]!.config;
  const workerModel = baseWorkerProviderCfg.model;
  if (!workerModel) {
    applyEvent({ v: 1, type: "agent.error", agent: e.parent,
      code: "no_worker_model", detail: "No model configured for worker — use /model worker <model-name>" });
    return;
  }
  const workerProviderCfg = baseWorkerProviderCfg;

  // Compute parent depth for child's memory
  const parentDepth = getState().agents.get(e.parent) ?
    (() => {
      let d = 0; let c = e.parent;
      for (let i = 0; i < 10; i++) {
        const info = getState().agents.get(c);
        if (!info?.parent) break; d++; c = info.parent;
      }
      return d;
    })() : 0;

  // Build parent chain
  const parentChain: string[] = [];
  let cur = e.parent;
  for (let i = 0; i < 10; i++) {
    const info = getState().agents.get(cur);
    if (!info) break;
    parentChain.unshift(cur);
    if (!info.parent) break;
    cur = info.parent;
  }

  const systemPrompt = buildSystemPrompt(
    e.role, e.child, e.goal, opts.resumedMemoryId,
    e.dispatch?.prompt_file ?? undefined,
  ) + `\n[任务定位] ${taskFor(e.child)?.profile ?? "implement"}。research/review 只允许读与检索；verify 负责检查并给出可核对证据；implement 执行修改。所有定位都使用同一 Worker 生命周期与共享预算，不创建额外管理层。`;
  const journal = sessionJournal();
  journal.bind(e.child, e.role, e.parent, e.goal, e.dispatch);
  if (!journal.isCurrent(e.child, e.session_revision)) return;
  if (opts.resumedMemoryId) journal.append("agent.recovered", journal.binding(e.child)!.conversation, e.child, journal.currentRevision(e.child)!, {});
  const a = new HttpConvAgent({
    id: e.child,
    role: e.role,
    sessionManaged: true,
    providerCfg: workerProviderCfg,
    modelCandidates: modelRoute.candidates, routingProfile: modelRoute.profile,
    systemPrompt,
    resumeFrom: opts.resumedMemoryId,
  });
  const unregisterSession = registerSessionAgent(e.child, () => {
    killAgent(e.child, "superseded requirement");
    updateAgentInfo(e.child, { state: "err", sub: "superseded" });
  });
  agents.set(e.child, a);
  globalBus.registerAgent(e.child, a);

  // S2: Secretary for this Worker
  const dispatch = e.dispatch ?? {
    background: e.goal,
    constraints: [],
    acceptance_criteria: ["agent.done"],
    stop_conditions: ["agent.done"],
  };
  const secretary = initSecretary(
    secretaries, e.child, opts.resumedMemoryId,
    () => ({
      agentId: e.child,
      agentType: e.role === "Secretary" ? "SECRETARY" : "WORKER",
      parentChain,
      depth: parentDepth + 1,
      model: workerModel,
      roleName: e.role,
      dispatch,
    }),
  );

  secretary.once("destroy", unregisterSession);

  // Pending tool calls emitted during one send() round — batched and executed on idle
  const toolQueue: Array<Extract<TuiEvent, { type: "tool.call" }>> = [];
  let workerActedThisTurn = false;
  let workerContinuations = 0;
  let workerGaveUp = false;
  let workerCorrectedThisTurn = false; // deduplicate illegal_message corrections per turn
  let workerNudgePending = false; // true when the next run turn is a system-initiated nudge
  let wLastToolKey = "";
  let wSameToolCount = 0;
  let wDoneNotified = false; // guard: only send completion notification to parent once
  let workerTerminal = false; // once agent.done is accepted, drop delayed/prose/tool events
  let outstandingTools = 0;
  let finishingFailure = false;
  let missingTerminalNudges = 0;
  let rejectedTodoCompletions = 0;
  const workerTurnShadow = new TurnController();
  const logWorkerTurnShadow = (): void => {
    if (process.env.SPAWN_SHADOW_TURN !== "1") return;
    logDiag(`[TurnController:shadow] ${e.child} ${JSON.stringify(workerTurnShadow.snapshot())}\n`);
  };
  // Coding completion guard: tracks last RunTests outcome.
  // Non-null means the worker called RunTests at least once this session.
  let wLastTestFailed: number | null = null; // null=never run, 0=all pass, N=N failures
  let wLastRunTestsSummary = "";
  // Test-evidence tracking for completion guard (covers Bash test runs, not just the RunTests tool):
  let wRanTestCommand = false;           // worker invoked RunTests OR a test-runner Bash cmd this session
  let wTestAttemptedButNoResult = false; // a test run produced NO parseable result (ECONNABORTED / cmd error / empty)

  // Circuit breaker constants
  const MAX_WORKER_TURNS = 40;
  const MAX_CONSEC_FAIL_TOOLS = 5;
  // Consecutive tool-failure counter — reset on any successful tool result
  let wConsecToolFails = 0;

  // Hard circuit (#2 main-chain liveness / full-duplex 地基): force-converge a stalled worker so it
  // can NEVER hold `active` forever and lock its TL/PM back into half-duplex. Unlike the nudge/escalate
  // path (workerContinuations resets on non-nudge runs → never reaches the gaveUp escalate, and even
  // that only notifies parent without agent.done), these counters are NOT resettable and ALWAYS end in
  // a forced agent.done(false) that releases `active`.
  const WORKER_HARD_STALL_N = 5;         // consecutive no-progress idle turns → circuit (early-stop 主力)
  const WORKER_HARD_MS = 15 * 60 * 1000; // wall-clock cap (防爆兜底, 宁松勿紧, 早停靠 stall)
  let wStallCount = 0;                    // turns with NO action AND NO queued tools (network-error空转/死锁)
  const wHardStartTs = Date.now();        // worker spawn wall-clock origin
  let wHardCircuitFired = false;          // one-shot guard
  let wLastFailOutput = "";               // most recent failing tool output (for handup last-error ③)

  // Quality tracking for worker
  let wQualTurns = 0;
  let wQualNudges = 0;
  let wQualHandup = false;
  let wLastTtftMs = 0;
  let wLastTotalMs = 0;

  const isTestRunnerBash = (ev: Extract<TuiEvent, { type: "tool.call" }>): boolean => {
    if (ev.name !== "Bash") return false;
    const cmd = typeof ev.args === "object" && ev.args !== null
      ? String((ev.args as Record<string, unknown>).command ?? (ev.args as Record<string, unknown>).cmd ?? "")
      : "";
    return /\b(?:npm\s+test|node\s+--test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/i.test(cmd);
  };

  // Force-converge a hard-stalled worker. Emits handup (③: 已完成 + 卡点 + 最后错误 — 半成品不随熔断丢)
  // THEN agent.done(false). Both flow through the existing handup/done handlers, which notify the parent
  // via sendCommand → the parent's QUEUE (⑤: never preempts the parent's in-flight turn). The done(false)
  // reuses the existing failure-notify path (④: TL → message→user with 重试/换方法/放弃 options), so the
  // background task's outcome flows back into the conversation on its own — no need for the user to ask.
  const fireHardCircuit = (reason: string): void => {
    if (wHardCircuitFired) return;
    if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
    wHardCircuitFired = true;
    const todos = getState().todosByAgent.get(e.child) ?? [];
    const doneTodos = todos.filter((t) => t.state === "done").map((t) => t.text);
    const stuckTodo = todos.find((t) => t.state === "run" || t.state === "todo")?.text ?? "(无明确 todo)";
    const lastErr = wLastFailOutput || "(无捕获错误，疑似网络重试无产出 / 空转)";
    const elapsedMs = Date.now() - wHardStartTs;
    recordHealthMetric({
      agent_id: e.child,
      event_type: "hard_circuit_fired",
      severity: "critical",
      reason,
      latency_ms: elapsedMs,
      meta: {
        parent: e.parent,
        stallCount: wStallCount,
        stuckTodo,
        doneTodos,
        lastError: lastErr.replace(/\s+/g, " ").slice(0, 500),
      },
    });
    logDiag(
      `[hard-circuit] worker=${e.child} reason=${reason} stall=${wStallCount} ` +
      `elapsed=${Math.round(elapsedMs / 1000)}s stuck-todo="${stuckTodo}" ` +
      `last-error="${lastErr.replace(/\s+/g, " ").slice(0, 120)}"\n`,
    );
    a.emit("event", {
      v: 1, type: "unit.handup", agent: e.child, parent: e.parent,
      summary: `[硬熔断:${reason}] 已完成: ${doneTodos.join("; ") || "(无)"}；卡在: ${stuckTodo}；最后错误: ${lastErr.replace(/\s+/g, " ").slice(0, 200)}`,
      artifacts: [], facts_to_promote: [], decisions: [], failed_acceptance: [stuckTodo],
    } as TuiEvent);
    a.emit("event", {
      v: 1, type: "agent.done", agent: e.child, success: false, reason: `hard-circuit ${reason}`,
    } as TuiEvent);
  };

  const controlled = taskFor(e.child);
  const deadlineTimer = controlled && setTimeout(() => fireHardCircuit("task-deadline"), Math.max(1, controlled.deadline - Date.now()));
  deadlineTimer?.unref();
  secretary.once("destroy", () => { if (deadlineTimer) clearTimeout(deadlineTimer); });

  a.on("event", (ev: TuiEvent) => {
    if(getState().agents.get(e.child)?.model!==a.cfg.providerCfg.model)updateAgentInfo(e.child,{model:a.cfg.providerCfg.model});
    if (finishingFailure && ev.type !== "token.usage") return;
    if (workerTerminal && ev.type !== "token.usage") {
      logDiag(`[${e.child}] dropped ${ev.type} after terminal agent.done\n`);
      return;
    }
    if (ev.type === "agent.state" && ev.state === "run" && !consumeTaskTurn(e.child)) { fireHardCircuit("shared-turn-or-time-budget"); return; }
    const hasPendingTools = ev.type === "agent.done" && ev.success && Object.values(sessionJournal().current(sessionJournal().binding(e.child)!.conversation)!.tools).some((t) => t.agent === e.child && t.revision === (e.session_revision ?? sessionJournal().binding(e.child)!.revision) && t.status === "pending");
    if (ev.type === "agent.done" && ev.success && (toolQueue.length || outstandingTools || hasPendingTools)) {
      const j = sessionJournal(), b = j.binding(e.child)!;
      j.append("completion.rejected", b.conversation, e.child, b.revision, { reason: "tools-pending", queued: toolQueue.length, running: outstandingTools });
      return; // Let the queued tools finish and feed their actual results first.
    }
    if (ev.type === "agent.done" && ev.success && (getState().todosByAgent.get(e.child) ?? []).some((t) => t.state === "todo" || t.state === "run")) {
      if (rejectedTodoCompletions++ < 2) setImmediate(() => { if (!workerTerminal && sessionJournal().isCurrent(e.child, e.session_revision)) a.sendCommand({ type: "user.message", text: "[系统-验收未闭环] TODO 仍未完成，不能报告成功。继续完成并更新 TODO；若阻塞，请 handup 给出未完成项、证据和原因。" }); });
      else fireHardCircuit("unresolved-todo-completion");
      return;
    }
    if (ev.type === "agent.done" && !ev.success && outstandingTools) {
      finishingFailure = true; toolQueue.length = 0;
      void cancelAgentToolsAndWait(e.child).then(() => { outstandingTools = 0; finishingFailure = false; a.emit("event", ev); });
      return;
    }

    // spawn: pre-check BEFORE applyEvent to prevent ghost agents in store
    if (ev.type === "spawn") {
      // Auto-rename on ID collision (concurrent forks often generate "tl-01" collisions).
      // Register a bus alias so parent's future message.to=originalId still routes to the renamed child.
      const resolvedSpawnEv = agents.has(ev.child)
        ? (() => {
            const newChildId = `${ev.child}-${Date.now().toString(36).slice(-4)}`;
            logDiag(`[${e.child}] spawn auto-rename: "${ev.child}"→"${newChildId}" (ID collision)\n`);
            globalBus.addAlias(ev.child, newChildId);
            return { ...ev, child: newChildId };
          })()
        : ev;
      // Normalize parent to actual spawner ID
      const normalizedEv = resolvedSpawnEv.parent !== e.child
        ? resolvedSpawnEv
        : { ...resolvedSpawnEv, parent: e.child };
      const parentRole = getState().agents.get(e.child)?.role;
      const check = pm.preCheckSpawn(normalizedEv, parentRole);
      if (!check.ok) {
        applyEvent({ v: 1, type: "agent.error", agent: e.child, code: check.code, detail: check.detail });
        return;
      }
      workerActedThisTurn = true;
      workerTurnShadow.markAction();
      applyEvent(normalizedEv);
      pm.observe(normalizedEv);
      startWorker(normalizedEv);
      return;
    }

    // Mirror agent.error from child to parent — UI + parent LLM
    if (ev.type === "agent.error") {
      applyEvent(ev);
      pm.observe(ev);
      if (ev.code === "http_error" || ev.code === "context_error" || ev.code === "session_budget") {
        wLastFailOutput = `${ev.code}: ${ev.detail ?? ""}`;
        fireHardCircuit("model-request-failed");
      } else taskNotice(e.parent, e.child, `[系统-诊断] ${e.child} [${ev.code}] ${ev.detail ?? ""}。先核对 TaskStatus 与现场，判断是否需要接管；不要仅因一条诊断就要求用户选择重试。`, agents, killedAgents);
      return;
    }

    // Block illegal messages before they reach the store
    if (ev.type === "message") {
      const senderRole = getState().agents.get(ev.agent)?.role;
      const recipientRole = ev.to !== "user" ? getState().agents.get(ev.to)?.role : undefined;
      const isWorkerToUser = senderRole === "Worker" && ev.to === "user";
      const isWorkerToWorker = senderRole === "Worker" && recipientRole === "Worker";
      // Non-root Leader (TL) must report to parent (PM), never directly to user.
      // e.parent is always set for TL (root PM has no parent).
      const isTLToUser = senderRole === "Leader" && ev.to === "user" && !!e.parent;
      if (isWorkerToUser || isWorkerToWorker || isTLToUser) {
        workerActedThisTurn = true; // prevent auto-continuation nudge loop
        workerTurnShadow.markAction();
        // _fallback messages are internal protocol noise (LLM wrote prose instead of JSON).
        // Drop silently — don't redirect to PM or it pollutes PM's context.
        if ((ev as any)._fallback) {
          logDiag(`[${e.child}] discarded _fallback protocol noise (to=${ev.to}): "${ev.text.slice(0, 80)}"\n`);
          return;
        }
        // Auto-forward to parent so the report is never lost, then correct.
        if (globalBus.hasAgent(e.parent)) {
          const redirected = { ...ev, to: e.parent } as typeof ev;
          applyEvent(redirected);      // store as child→parent (visible in both panes)
          globalBus.routeMessage(e.child, e.parent, ev.text, { prefix: `[${e.child}→${e.parent}]` });
        }
        if (!workerCorrectedThisTurn) {
          workerCorrectedThisTurn = true;
          const detail = isTLToUser
            ? `TL ${ev.agent} message.to=user 越级 — 已自动转发至 ${e.parent}（PM）。TL 汇报对象为 PM，不得直接联系用户。`
            : `Worker ${ev.agent} message.to=${ev.to} 违规 — 已自动转发至 ${e.parent} 并纠正。`;
          applyEvent({ v: 1, type: "agent.error", agent: ev.agent, code: "illegal_message", detail });
          pm.observe(ev);
          setImmediate(() => {
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({
              type: "user.message",
              text: isTLToUser
                ? `[系统-纠正] message.to=user 已拦截并转发给 PM（${e.parent}）。请使用 message.to=${e.parent}，由 PM 转发给用户。`
                : `[系统-纠正] message.to=${ev.to} 违规已被自动转发至 ${e.parent}。下次请直接使用 message.to=${e.parent}，然后 agent.done。`,
            });
          });
        }
        return;
      }
    }

    // Coding completion guard: if RunTests was run and failed, block success claims.
    // Intercepted BEFORE applyEvent so the "done" state is never committed.
    if (ev.type === "agent.done" && decideDoneGuard({ success: !!ev.success, lastTestFailed: wLastTestFailed, ranTestCommand: wRanTestCommand }) === "test_failed") {
      logDiag(
        `[${e.child}] completion guard: blocked agent.done(success) — RunTests shows ${wLastTestFailed} failure(s)\n`,
      );
      recordHealthMetric({
        agent_id: e.child,
        event_type: "test_failed_but_claimed_done",
        severity: "critical",
        reason: `agent_done_success_blocked_with_${wLastTestFailed}_test_failures`,
        meta: {
          parent: e.parent,
          failedTests: wLastTestFailed,
          runTestsSummary: wLastRunTestsSummary,
        },
      });
      recordHealthMetric({
        agent_id: e.child,
        event_type: "agent_done_blocked_by_guard",
        severity: "warn",
        reason: "test_failed_but_claimed_done",
        meta: {
          parent: e.parent,
          failedTests: wLastTestFailed,
        },
      });
      setImmediate(() => {
        if (killedAgents.has(e.child) || getState().agents.get(e.child)?.state === "done") return;
        a.sendCommand({
          type: "user.message",
          text: `[系统-测试未通过] 你声明 success:true，但最近一次 RunTests 显示 ${wLastTestFailed} 个失败。` +
                `必须先修复所有失败的测试，然后重新运行 RunTests 确认全绿，再 agent.done。`,
        });
      });
      return; // Reject: keep agent running so it can fix the failures
    }
    // 方案2(证据判定，非关键词)：worker 跑过测试命令(wRanTestCommand)，却从未取得有效通过记录
    // (wLastTestFailed 仍为 null — failN>0 已被上面拦，0 是真全绿放行)，却声称 success → 拦截。
    if (ev.type === "agent.done" && decideDoneGuard({ success: !!ev.success, lastTestFailed: wLastTestFailed, ranTestCommand: wRanTestCommand }) === "missing_evidence") {
      logDiag(
        `[${e.child}] completion guard: blocked agent.done(success) — ran test cmd but NO valid test result (attempted=${wTestAttemptedButNoResult})\n`,
      );
      recordHealthMetric({
        agent_id: e.child,
        event_type: "agent_done_blocked_by_guard",
        severity: "warn",
        reason: "missing_valid_test_evidence",
        meta: {
          parent: e.parent,
          testAttemptedButNoResult: wTestAttemptedButNoResult,
        },
      });
      setImmediate(() => {
        if (killedAgents.has(e.child) || getState().agents.get(e.child)?.state === "done") return;
        a.sendCommand({
          type: "user.message",
          text: `[系统-无测试证据] 你声称 success:true，但系统没有任何有效的测试运行记录` +
                `（测试命令跑过但未产出可解析的 pass/fail 计数，可能因网络中断、命令不存在或输出为空）。` +
                `必须真正跑通测试并确认全绿（RunTests 或 node --test 输出含 pass≥1 且 fail 为 0），再 agent.done。`,
        });
      });
      return; // Reject: no valid test evidence for a success claim
    }

    applyEvent(ev);
    pm.observe(ev);

    // ── per-event debug logging ──────────────────────────────────────────────
    if (ev.type === "agent.state") {
      logDiag(`[${e.child}] state→${ev.state} acted=${workerActedThisTurn} cont=${workerContinuations} gaveUp=${workerGaveUp}\n`);
    }
    if (ev.type === "message") {
      logDiag(`[${e.child}] message to=${ev.to} "${ev.text.slice(0, 120)}"\n`);
    }
    if (ev.type === "todo.set") {
      const summary = (ev.items as Array<{state: string; text: string}>).map((t) => `[${t.state}]${t.text.slice(0,30)}`).join(", ");
      logDiag(`[${e.child}] todo.set ${ev.items.length} items: ${summary}\n`);
    }
    if (ev.type === "tool.call") {
      logDiag(`[${e.child}] tool.call ${ev.name}(${JSON.stringify(ev.args).slice(0, 100)})\n`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Forward worker→parent communication to the parent LLM ────────────────
    // Without this, leader spawns a worker but never hears back — hangs forever.
    if (ev.type === "message" && ev.to === e.parent) {
      globalBus.routeMessage(e.child, e.parent, ev.text, { prefix: `[${e.child}→${e.parent}]` });
    }
    if (ev.type === "token.usage") {
      if (ev.ttft_ms !== undefined) wLastTtftMs = ev.ttft_ms;
      if (ev.total_ms !== undefined) wLastTotalMs = ev.total_ms;
    }
    if (ev.type === "agent.state" && ev.state === "run") {
      workerTurnShadow.beginTurn();
      if (workerNudgePending) wQualNudges++;
      wQualTurns++;
      // Hard turn limit — force handup so worker can't loop indefinitely
      if (wQualTurns > MAX_WORKER_TURNS) { fireHardCircuit("turn-budget-exhausted"); return; }
    }
    if (ev.type === "unit.handup") wQualHandup = true;
    if (ev.type === "agent.done") {
      workerTerminal = true;
      toolQueue.length = 0;
      workerActedThisTurn = true;
      workerTurnShadow.markAction();
      const wTok = getState().tokensByAgent.get(e.child);
      const wScore = Math.max(0, Math.min(100,
        100
        - wQualNudges * 8
        - (workerGaveUp ? 25 : 0)
        - (wQualHandup ? 15 : 0)
        - (ev.success ? 0 : 20)
        + (ev.evidence?.length ? 10 : 0)
        + (wQualNudges === 0 ? 10 : 0)
      ));
      logDiag(
        `[quality] ${e.child} session=${secretary.getMemory()?.session_hash ?? "?"} score=${wScore}` +
        ` success=${ev.success} turns=${wQualTurns} nudges=${wQualNudges}` +
        ` handup=${wQualHandup} gaveUp=${workerGaveUp}` +
        ` tokens_in=${wTok?.prompt ?? 0} tokens_out=${wTok?.completion ?? 0}` +
        ` evidence=${ev.evidence?.length ?? 0}` +
        ` latency=${e.child}:${wLastTtftMs}/${wLastTotalMs}\n`,
      );
      // Resolve foreground tracking so parent's pm.getForegroundChildren() reflects completion
      pm.completeForeground(e.child, { success: ev.success, reason: ev.reason, evidence: ev.evidence });
      // Guard: only notify parent once — workers can emit agent.done multiple times if nudged
      if (!wDoneNotified) {
        wDoneNotified = true;
        if (ev.success) {
          const evidenceLines = ev.evidence?.length
            ? "\n证据:\n" + ev.evidence.map((s) => `  - ${s}`).join("\n")
            : "";
          taskNotice(e.parent, e.child, `[系统] ${e.child} 自报完成${ev.reason ? ": " + ev.reason : ""}。${evidenceLines}\n请核对验收证据并继续推进任务。`, agents, killedAgents);
        } else {
          taskNotice(e.parent, e.child, `[系统-失败] ${e.child} 停止${ev.reason ? ": " + ev.reason : ""}。请依据持久交接决定补充上下文、续派或换策略。不要把未完成当作成功；只有确需用户决策时才中断用户。`, agents, killedAgents);
        }
      }
      globalBus.unregisterAgent(e.child);
      // Stop observation after the final snapshot, retaining completed history.
      secretaries.get(e.parent)?.ingestChildMemory(secretary.getMemory() as any);
      destroySecretary(secretaries, e.child);
      a.kill(); // Drop queued internal prompts after the durable terminal event.
      // Keep the completed snapshot for history and explicit resume.
    }
    if (ev.type === "unit.handup") {
      workerTurnShadow.markParentReport();
      const parentAgent = agents.get(e.parent);
      if (!outstandingTools && !wHardCircuitFired && parentAgent instanceof HttpConvAgent) {
        const findingLines = ev.findings?.length
          ? "\n发现（按级别）:\n" + ev.findings.map((f) => `  [${f.level}] ${f.text}`).join("\n")
          : "";
        const failedLines = ev.failed_acceptance?.length
          ? "\n未达成: " + ev.failed_acceptance.join("; ")
          : "";
        parentAgent.sendCommand({
          type: "user.message",
          text: `[${e.child} handup] 已完成: ${ev.summary}${failedLines}${findingLines}`,
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Track turn start
    if (ev.type === "agent.state" && ev.state === "run") {
      workerActedThisTurn = false;
      workerCorrectedThisTurn = false;
      if (!workerNudgePending) { workerContinuations = 0; workerGaveUp = false; }
      workerNudgePending = false;
    }

    // Registry is the authority for needsApproval — prevents agent from forging false.
    // Destructive Bash commands are routed to leader instead of asking user directly.
    if (ev.type === "tool.call") {
      workerActedThisTurn = true;
      workerTurnShadow.markAction();
      if (ev.name === "RunTests" || isTestRunnerBash(ev)) wRanTestCommand = true;
      const wToolKey = `${ev.name}:${JSON.stringify(ev.args)}`;
      if (wToolKey === wLastToolKey) { wSameToolCount++; } else { wLastToolKey = wToolKey; wSameToolCount = 1; }
      if (wSameToolCount >= 3) {
        const output =
          `[系统-重复工具拦截] 你已连续 ${wSameToolCount} 次调用相同的 ${ev.name} 和相同参数。` +
          `该调用已被拒绝，不会再次执行。请基于已有 tool.result 推进；` +
          `如果已完成，立即 message.to=${e.parent} 汇报并 agent.done。`;
        applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output });
        a.sendCommand({ type: "user.message", text: output });
        return;
      }
      if (wLastTestFailed === 0 && (ev.name === "RunTests" || isTestRunnerBash(ev))) {
        const output =
          `[系统-测试已通过] 最近一次 RunTests 已全绿，禁止重复运行测试消耗时间。\n` +
          `${wLastRunTestsSummary}\n\n` +
          `现在必须 message.to=${e.parent} 汇报改动和测试结果，然后 agent.done(success:true)。`;
        applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output });
        a.sendCommand({ type: "user.message", text: output });
        return;
      }
      const mustApprove = toolNeedsApproval(ev.name, ev.args as Record<string, unknown>);
      if (!mustApprove) {
        toolQueue.push(ev);
      } else {
        const cmd = typeof ev.args === "object" && ev.args !== null
          ? String((ev.args as Record<string, unknown>).command ?? (ev.args as Record<string, unknown>).cmd ?? "")
          : "";
        const approverAgent = findApproverLeader(e.child, { agents, getState });
        const approverId = getState().agents.get(e.parent)?.id ?? e.parent;
        if (approverAgent) {
          leaderApprovalQueue.set(ev.id, {
            workerAgent: a, toolName: ev.name, toolArgs: ev.args, workerChildId: e.child, revision: ev.session_revision,
          });
          approverAgent.sendCommand({
            type: "user.message",
            text: `[系统-Bash审批 id=${ev.id}] ${e.child} 请求执行破坏性命令（goal: ${e.goal}）:\n\`${cmd}\`\n\n如在 goal 边界内，回复:\n{"v":1,"type":"tool.approved","id":"${ev.id}"}\n否则:\n{"v":1,"type":"tool.rejected","id":"${ev.id}","reason":"越界原因"}`,
          });
        } else {
          applyEvent({ v: 1, type: "tool.result", agent: e.child, id: ev.id, ok: false, output: `No approver leader found for ${approverId}` });
          a.sendCommand({ type: "tool.result", id: ev.id, ok: false, output: `No approver leader found for ${approverId}` });
        }
      }
    }

    // Sending a message counts as acting — same logic as in startLeader.
    if (ev.type === "message") {
      workerActedThisTurn = true;
      if (ev.to === e.parent) workerTurnShadow.markParentReport();
      else if (ev.to === "user") workerTurnShadow.markUserReply();
      else workerTurnShadow.markAction();
    }

    // Agent 变 idle → 批量执行排队的工具并把结果回喂给 agent
    if (ev.type === "agent.state" && ev.state === "idle") {
      if (getState().agents.get(e.child)?.state === "done") return;
      workerTurnShadow.endTurn();
      logWorkerTurnShadow();
      // Hard-circuit stall tracking (#2): a turn with NO action AND NO queued tools = no progress
      // (network-error 空转 / idle 死锁 命中). NOT reset by nudges, so it eventually fires — unlike the
      // resettable workerContinuations path that network errors keep zeroing out.
      if (toolQueue.length === 0 && !workerActedThisTurn) wStallCount++;
      else wStallCount = 0;
      if (!wHardCircuitFired) {
        const elapsed = Date.now() - wHardStartTs;
        if (wStallCount >= WORKER_HARD_STALL_N) { fireHardCircuit(`stall x${wStallCount}`); return; }
        if (elapsed > WORKER_HARD_MS) { fireHardCircuit(`wall-clock ${Math.round(elapsed / 60000)}min`); return; }
      }
      if (toolQueue.length > 0) {
        if (wSameToolCount >= 2) {
          const loopTool = wLastToolKey.split(":")[0] ?? "";
          logDiag(`[${e.child}] loop-detect: ${loopTool} called same args ${wSameToolCount}x\n`);
          const warnMsg = `【系统-循环检测】你已连续 ${wSameToolCount} 次调用相同的 ${loopTool}，得到相同结果。换一个不同的工具或不同参数。`;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({ type: "user.message", text: warnMsg });
          });
        }
        const batch = toolQueue.splice(0);
        outstandingTools += batch.length;
        setImmediate(async () => {
          // Guard: agent may have reached terminal state while this callback was queued.
          if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) { outstandingTools = Math.max(0, outstandingTools - batch.length); return; }
          const results = await runToolBatch(batch, e.child);
          if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
          // Defer delivery via setImmediate so the I/O phase can drain SSE events (including
          // agent.done from the LLM stream) before we re-check and deliver. A microtask
          // continuation here would fire BEFORE pending SSE I/O, missing a concurrent agent.done.
          setImmediate(() => {
            outstandingTools = Math.max(0, outstandingTools - batch.length);
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) {
              logDiag(`[${e.child}] dropped tool.result for ${batch.length} tool(s) — agent done during execution\n`);
              return;
            }
            for (let i = 0; i < batch.length; i++) {
              const { id } = batch[i]!;
              const { ok, output } = results[i]!;
              if (batch[i]!.name === "Edit" || batch[i]!.name === "Write") {
                wLastTestFailed = null;
                wLastRunTestsSummary = "";
                wTestAttemptedButNoResult = false;
              }
              // Track consecutive failures for circuit breaker + capture last failure for hard-circuit handup.
              if (ok) { wConsecToolFails = 0; } else { wConsecToolFails++; wLastFailOutput = output; }
              // Coding completion guard: track RunTests outcome so we can reject a
              // premature agent.done(success:true) when tests are still failing.
              if (batch[i]!.name === "RunTests") {
                const failMatch = output.match(/failed:\s*(\d+)/);
                wLastTestFailed = failMatch ? parseInt(failMatch[1]!, 10) : (ok ? 0 : 1);
                if (wLastTestFailed === 0) {
                  wTestAttemptedButNoResult = false;
                  const passMatch = output.match(/passed:\s*(\d+)/);
                  const skippedMatch = output.match(/skipped:\s*(\d+)/);
                  wLastRunTestsSummary =
                    `RunTests PASS: passed=${passMatch?.[1] ?? "?"}, failed=0, skipped=${skippedMatch?.[1] ?? "0"}`;
                }
              } else if (isTestRunnerBash(batch[i]!)) {
                // Bash 跑测试 — node test runner 格式 (# fail N / ℹ fail N)，独立正则，三态回填。
                // 全绿判定必须 passN ≥ 1：pass 0/fail 0(测试没跑起来的异常输出)不得判全绿，
                // 落到"无有效结果"被 guard 拦——worker 不能靠输出里有个 pass 字样蒙混。
                // BACKLOG: RunTests 分支的 `ok ? 0` 有同款"未真跑即判 0"隐患；两处全绿判定将来应
                // 抽成同一函数(要求 pass≥1)防逻辑漂移。本次范围内不改 RunTests 分支以免扩大。
                const failM = output.match(/(?:#|ℹ)\s*fail(?:ed)?\s+(\d+)/i);
                const passM = output.match(/(?:#|ℹ)\s*pass(?:ed)?\s+(\d+)/i);
                const failN = failM ? parseInt(failM[1]!, 10) : null;
                const passN = passM ? parseInt(passM[1]!, 10) : null;
                if (failN !== null && failN > 0) {
                  wLastTestFailed = failN;
                  wTestAttemptedButNoResult = false;
                } else if (passN !== null && passN > 0 && (failN === 0 || failN === null)) {
                  // 真全绿：至少 1 个 pass 且无 fail
                  wLastTestFailed = 0;
                  wTestAttemptedButNoResult = false;
                  wLastRunTestsSummary = `Bash test PASS: passed=${passN}, failed=${failN ?? 0}`;
                } else {
                  // pass 0 / fail 0 / 都解不出（ECONNABORTED、命令不存在、空输出）→ 无有效结果
                  wTestAttemptedButNoResult = true; // wLastTestFailed 保持 null
                }
              }
              applyEvent({ v: 1, type: "tool.result", agent: e.child, id, ok, output, session_revision: batch[i]!.session_revision });
            }
            // Use user.message so the [tool_result id=...] headers in `combined` aren't
            // double-wrapped (sendCommand type:"tool.result" would add an extra header).
            let combined = formatToolResults(batch, results);
            // Circuit breaker: append forced-handup directive when consecutive failures hit threshold
            if (wConsecToolFails >= MAX_CONSEC_FAIL_TOOLS) {
              wConsecToolFails = 0;
              combined +=
                `\n\n[系统-熔断] 最近 ${MAX_CONSEC_FAIL_TOOLS} 次工具调用全部失败，触发降级熔断。` +
                `禁止继续换工具试错。立即 unit.handup 给 ${e.parent}，说明：` +
                `① 你在尝试什么操作 ② 用了哪些工具 ③ 每次的具体错误信息。`;
            }
            if (batch.some((c) => c.name === "RunTests") && wLastTestFailed === 0) {
              combined +=
                `\n\n[系统-测试通过收束] ${wLastRunTestsSummary}。` +
                `禁止再次调用 RunTests 或 Bash 测试命令。立即 message.to=${e.parent} 汇报改动和测试结果，` +
                `然后 agent.done(success:true)。`;
            }
            a.sendCommand({ type: "user.message", text: combined });
          });
        });
        // Worker acted but may still have pending todos — auto-close or nudge
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasRun  = todos.some((t) => t.state === "run");
        const hasTodo = todos.some((t) => t.state === "todo");
        if ((hasRun || hasTodo) && workerContinuations < 3) {
          workerContinuations++;
          const pendingTodos = todos.filter((t) => t.state === "todo" || t.state === "run").map((t) => t.text).join("; ");
          workerNudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({
              type: "user.message",
              text: `【系统-自检】你执行了部分操作但 todo 列表仍有未完成项：${pendingTodos}。立刻继续执行下一步：输出 step + tool.call。`,
            });
          });
        } else if (hasRun || hasTodo) {
          fireHardCircuit("unfinished-todos");
        }
      } else if (!workerActedThisTurn && !workerGaveUp) {
        // Worker planned but didn't act — nudge to continue
        const todos = getState().todosByAgent.get(e.child) ?? [];
        const hasPending = todos.some((t) => t.state === "todo" || t.state === "run");
        if (hasPending && workerContinuations < 3) {
          workerContinuations++;
          workerNudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({ type: "user.message", text: "【系统】你有未完成的 todo。立刻执行下一步：输出 step + tool.call，不要只规划。" });
          });
        } else if (hasPending) {
          // 3 nudges failed — terminate the worker as failed so it cannot remain
          // idle forever and keep the parent/Feishu queue blocked.
          workerGaveUp = true;
          fireHardCircuit("nudge-exhausted");
        } else if (workerContinuations < 2) {
          // Worker processed a message but produced no output, and has no pending todos.
          workerContinuations++;
          workerNudgePending = true;
          setImmediate(() => {
            if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
            if (getState().agents.get(e.child)?.state === "done" || killedAgents.has(e.child)) return;
            a.sendCommand({
              type: "user.message",
              text: "【系统-回复缺失】你处理了消息但没有任何输出。请立刻 message→parent 报告当前状态，或继续执行任务。",
            });
          });
        } else {
          workerGaveUp = true;
          fireHardCircuit("silent-no-output");
        }
      }
      if (!workerTerminal && !finishingFailure && !toolQueue.length && !outstandingTools && workerActedThisTurn && !workerNudgePending) {
        if (missingTerminalNudges++ < 2) {
          workerNudgePending = true;
          setImmediate(() => { if (!workerTerminal && !killedAgents.has(e.child) && sessionJournal().isCurrent(e.child, e.session_revision)) a.sendCommand({ type: "user.message", text: "[系统-任务未闭环] 你已汇报但未明确结束。满足验收则 agent.done 并附证据；否则继续执行或 unit.handup 说明未完成事项，不要静默停在 idle。" }); });
        } else fireHardCircuit("missing-terminal-report");
      }
    }
  });

  secretary.on("event", (ev: TuiEvent) => applyEvent(ev));

  // S2: persist messages
  a.on("_raw_message", (m: { role: "user" | "assistant"; content: string }) => {
    secretary.observeMessage(m.role, m.content);
  });

  // Set depth and resolved model so AgentRow shows the actual model (not "{{WORKER_MODEL}}" or "?")
  updateAgentInfo(e.child, { depth: parentDepth + 1, model: workerModel });

  // Build initial message from goal + dispatch context so worker has full picture
  const dispatchCtx = e.dispatch;
  let initMsg = opts.firstMessage ?? e.goal;
  if (!opts.firstMessage && dispatchCtx) {
    const parts: string[] = [`任务目标：${e.goal}`];
    if (dispatchCtx.background) parts.push(`背景：${dispatchCtx.background}`);
    if (dispatchCtx.constraints?.length) parts.push(`约束：${dispatchCtx.constraints.join("；")}`);
    if (dispatchCtx.acceptance_criteria?.length) parts.push(`验收标准：${dispatchCtx.acceptance_criteria.join("；")}`);
    initMsg = parts.join("\n");
  }
  // Always inject parent ID so TL/Worker knows exactly which agent to report to.
  initMsg += `\n汇报对象（你的 parent agent ID）：${e.parent}`;
  // Inject parent TL's confirmed facts (Codex fork-spawn pattern):
  // Worker gets cross-task context without needing to re-read parent history.
  const parentSec = secretaries.get(e.parent);
  if (parentSec) {
    const parentFacts = topFactsByWeight(parentSec.getMemory(), 5);
    if (parentFacts.length > 0) {
      const factsBlock = parentFacts.map((f) => `  - ${f.text}`).join("\n");
      initMsg += `\n\n【父级已确认事实 (TL working_set)】\n${factsBlock}`;
    }
  }
  void waitForSessionControl(e.child).then(() => prepareWorkspace(e.child)).then(() => { if (!killedAgents.has(e.child) && sessionJournal().isCurrent(e.child, e.session_revision)) a.sendCommand({ type: "user.message", text: initMsg + "\n[文件隔离] 工具使用任务副本；使用相对路径。禁止通过绝对路径或父目录修改原工作区。发布由控制器进行，遇到冲突应交给 PM。" }); }).catch((error) => a.emit("event", { v: 1, type: "agent.error", agent: e.child, code: "context_error", detail: `Workspace preparation failed: ${String(error)}` }));

  // ── Auto-background: register foreground spawn for parent → child tracking ──
  const parentInfo = getState().agents.get(e.parent);
  // Only register foreground tracking if parent is a Leader/PM (not worker)
  if (parentInfo && parentInfo.role !== "Worker") {
    const handle = pm.registerSpawn(e.child, e.parent);
    // When the foreground promise resolves (30s sync or 2min bg switch):
    handle.promise.then((syncResult) => {
      if (!sessionJournal().isCurrent(e.child, e.session_revision)) return;
      if (syncResult === null) {
        // Switched to background: notify parent
        const parentAgent = agents.get(e.parent);
        if (parentAgent instanceof HttpConvAgent) {
          parentAgent.sendCommand({
            type: "user.message",
            text: `[系统] ${e.child} 已超过 2 分钟，自动切换为后台模式。完成时会通过 task-notification 通知你。`,
          });
        }
      }
      // If syncResult !== null, the 30s synchronous completion already happened
      // and the parent was notified directly inside agent.done handler.
    });
  }
}
