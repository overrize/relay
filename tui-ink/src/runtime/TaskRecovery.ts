import { sessionJournal } from "../session/Journal.js";
import { taskFor, workItems, taskState, safeToRetry, reserveAttempt, checkedFile, checkedDirectory, type WorkItem } from "../session/Tasks.js";
import { waitForSessionControl } from "../session/Control.js";
import { getHandlerDeps } from "./HandlerContext.js";
import { startWorker } from "./WorkerHandler.js";
import { applyEvent, getState } from "../store.js";
import type { TuiEvent } from "../protocol.js";
import { cancelAgentToolsAndWait } from "../tools/command.js";
import { workspacePath, publishWorkspace, agentFile, workspaceChanges } from "../session/Workspaces.js";

const timers = new Map<string, ReturnType<typeof setTimeout>>(), resolving = new Map<string, Promise<void>>();
const key = (id: string) => `${process.cwd()}\0${id}`;
function publish(t: WorkItem, text: string) {
  const j = sessionJournal(), deps = getHandlerDeps(); if (!deps || j.current(t.conversation)?.revision !== t.revision) return;
  let parent = t.parent;
  for (let i = 0; i < 8; i++) {
    const b = j.binding(parent); if (!b?.parent || (deps.agents.has(parent) && !deps.killedAgents.has(parent) && !["done", "err"].includes(getState().agents.get(parent)?.state ?? ""))) break;
    parent = b.parent;
  }
  const id = `control:${t.id}:${j.sequence().seq}`;
  const input = j.acceptNotice(parent, id, `[任务控制 ${t.id}] ${text}\n用 TaskStatus 查看共享预算、验收与操作凭据。`, t.revision);
  if (input && !deps.killedAgents.has(parent) && deps.secretaries.has(parent)) deps.agents.get(parent)?.receiveRuntimeNotice(id, input.text, t.revision);
}
function fresh(t: WorkItem) { return sessionJournal().current(t.conversation)?.work?.[t.id]; }
export function armTask(t: WorkItem) {
  const k = key(t.id); if (timers.has(k)) return;
  const root = process.cwd();
  const timer = setTimeout(() => {
    timers.delete(k); if (process.cwd() !== root) return;
    void launchAttempt(t.id, t.conversation).catch((error) => {
      const current = fresh(t); if (current && current.revision === sessionJournal().current(current.conversation)?.revision) { taskState(current, { status: "blocked", reason: `launch-failed:${String(error)}` }); publish(current, `续派被阻止：${String(error)}`); }
    });
  }, Math.max(1, Math.min(2147483647, (t.nextAt ?? Date.now()) - Date.now())));
  timer.unref(); timers.set(k, timer);
}
export function stopTaskRecovery() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); }
export function recordTaskCancellation(agent: string, reason: string) {
  const j = sessionJournal(), t = taskFor(agent); if (!t || t.latestAgent !== agent || !j.isCurrent(agent, t.revision) || !["running", "evaluating"].includes(t.status)) return;
  applyEvent({ v: 1, type: "agent.done", agent, success: false, reason: `user-stop: ${reason}`, session_revision: t.revision }); queueTaskResolution(agent);
}
function scheduleRetry(t: WorkItem, reason: string, requested = false) {
  t = fresh(t)!; if (!t || t.revision !== sessionJournal().current(t.conversation)?.revision) return;
  if (t.attempts.length >= t.maxAttempts || t.usedTurns >= t.maxTurns || t.usedRequests >= t.maxRequests || t.usedTools >= t.maxTools || Date.now() >= t.deadline) {
    taskState(t, { status: "exhausted", reason: "task-budget-exhausted" }); publish(t, "共享预算已耗尽，保留交接等待 PM 决策；不会自动增加预算。"); return;
  }
  const blocker = safeToRetry(t);
  if (blocker) { taskState(t, { status: "blocked", reason: blocker }); publish(t, `存在需要核查的副作用，未自动重做：${blocker}`); return; }
  if (t.mode === "manual" && !requested) { taskState(t, { status: "blocked", reason: `manual-mode:${reason}` }); publish(t, "自动续派已暂停，可用 TaskRetry 在原预算内继续。"); return; }
  const nextAt = Date.now() + Math.min(10000, 500 * 2 ** Math.max(0, t.attempts.length - 1));
  taskState(t, { status: "retry_wait", reason, nextAt, retryRequested: requested });
  publish(t, `已安排第 ${t.attempts.length + 1}/${t.maxAttempts} 次尝试，退避后仅继续未完成工作。`); armTask(fresh(t)!);
}
export async function evaluateTask(agent: string) {
  const root = process.cwd();
  let t = taskFor(agent); if (!t || t.latestAgent !== agent || !["running", "evaluating"].includes(t.status)) return;
  const j = sessionJournal(), b = j.binding(agent); if (!b?.outcome || !j.isCurrent(agent, t.revision)) return;
  taskState(t, { status: "evaluating", reason: b.outcome.reason });
  await waitForSessionControl(t.parent); await cancelAgentToolsAndWait(agent);
  if (process.cwd() !== root || !j.isCurrent(agent, t.revision)) return;
  const details: string[] = [], covered = new Set<number>(); let passed = t.checks.length > 0;
  for (const [index, check] of t.checks.entries()) {
    if (Date.now() >= t.deadline || !j.isCurrent(agent, t.revision)) { passed = false; break; }
    try {
      if (check.type === "test_suite") {
        const project = checkedDirectory(check.path, workspacePath(t)), id = `accept-${t.id}-${t.attempts.length}-${index}`;
        const args = { project_dir: project, strict: true, timeout_ms: Math.max(1, Math.min(180000, t.deadline - Date.now())), ...(t.workspace ? { task: t.id } : {}) };
        applyEvent({ v: 1, type: "tool.call", agent: t.parent, id, name: "RunTests", args, session_revision: t.revision });
        const { executeTool } = await import("../tools/registry.js");
        const result = await executeTool("RunTests", args, { agentId: t.parent, callId: id, revision: t.revision });
        applyEvent({ v: 1, type: "tool.result", agent: t.parent, id, ok: result.ok, output: result.output, session_revision: t.revision });
        covered.add(check.criterion); passed &&= result.ok; details.push(`${result.ok ? "PASS" : "FAIL"} criterion=${check.criterion} test_suite ${check.path}: ${result.output.slice(0, 500)}`);
      } else {
        const f = checkedFile(check.path, workspacePath(t)); const ok = check.type === "file_sha256" ? f.sha256 === check.value!.toLowerCase() : f.bytes.toString("utf8").includes(check.value!); covered.add(check.criterion); details.push(`${ok ? "PASS" : "FAIL"} criterion=${check.criterion} ${check.type} ${f.path} sha256=${f.sha256}`); passed &&= ok;
      }
    }
    catch (error) { passed = false; details.push(`FAIL criterion=${check.criterion} ${String(error)}`); }
    await new Promise<void>((r) => setImmediate(r));
  }
  t = fresh(t)!; if (!t || !j.isCurrent(agent, t.revision)) return;
  for (const check of t.checks.filter((c) => c.type !== "test_suite")) try { const f = checkedFile(check.path, workspacePath(t)); passed &&= check.type === "file_sha256" ? f.sha256 === check.value!.toLowerCase() : f.bytes.toString("utf8").includes(check.value!); } catch { passed = false; }
  const allCovered = t.dispatch.acceptance_criteria.every((_: unknown, index: number) => covered.has(index));
  const blocker = safeToRetry(t);
  if (passed && allCovered && !blocker && !b.outcome.remaining.length) {
    try { await publishWorkspace(t); } catch (error) { taskState(t, { status: "blocked", reason: `workspace-publish:${String(error)}` }); publish(t, String(error)); return; }
    taskState(t, { status: "accepted", reason: "deterministic-checks-passed", verdict: { passed: true, details, at: Date.now(), reviewer: "runtime-file-checks" } }); publish(t, "约定的全部机器检查已通过，逻辑任务已验收；不再续派。"); return;
  }
  if (b.outcome.reportedSuccess && (!t.checks.length || !allCovered)) {
    taskState(t, { status: "awaiting_review", reason: "independent-review-required", verdict: { passed: false, details, at: Date.now(), reviewer: "runtime-file-checks" } }); publish(t, "Worker 仅自报完成；验收检查未覆盖全部标准，需要 PM 独立检查后 TaskReview。"); return;
  }
  if (blocker) { taskState(t, { status: "blocked", reason: blocker }); publish(t, `任务仍需核对副作用：${blocker}`); return; }
  if (t.usedTurns >= t.maxTurns || t.usedRequests >= t.maxRequests || t.usedTools >= t.maxTools || Date.now() >= t.deadline) { scheduleRetry(t, "shared-budget-exhausted"); return; }
  const error = b.outcome.lastError ?? b.lastError ?? "", reason = b.outcome.reason;
  if (/\b(?:400|401|402|403|404)\b|permission|unauthori[sz]ed|api.?key|credential|权限|取消|cancelled|user.?stop|SESSION_BUDGET|SUBSCRIPTION_/i.test(error + " " + reason)) { taskState(t, { status: "blocked", reason: `non-retryable:${reason}`, verdict: { passed: false, details, at: Date.now(), reviewer: "runtime" } }); publish(t, "权限、配置或主动停止类问题不会自动重试，交接已保留。"); return; }
  const transient = /model-request-failed/.test(reason) && /429|50[0234]|timeout|timed.?out|ECONN|socket|fetch failed/i.test(error);
  const progress = Object.values(t.operations).some((op) => op.agent === agent && op.status === "completed" && op.ok && !Object.values(t!.operations).some((old) => old.agent !== agent && old.signature === op.signature && old.status === "completed" && old.ok));
  if (transient || (progress && /missing-terminal|unfinished-todo|nudge-exhausted|turn-budget|process-restart|retryable:|acceptance-rejected/.test(reason)) || (t.checks.length > 0 && b.outcome.reportedSuccess)) {
    taskState(t, { verdict: { passed: false, details, at: Date.now(), reviewer: "runtime" } }); scheduleRetry(fresh(t)!, t.checks.length && b.outcome.reportedSuccess ? "acceptance-failed" : reason); return;
  }
  taskState(t, { status: "blocked", reason: progress ? `needs-plan:${reason}` : `no-progress:${reason}`, verdict: { passed: false, details, at: Date.now(), reviewer: "runtime" } }); publish(t, "没有可确认的新进展或停止原因不适合自动重试，等待 PM 核查并用 TaskRetry 继续原任务。");
}
export function queueTaskResolution(agent: string) {
  const root = process.cwd();
  const t = taskFor(agent); if (!t || !["running", "evaluating"].includes(t.status)) return;
  const k = key(t.id); if (resolving.has(k)) return;
  const job = Promise.resolve().then(() => { if (process.cwd() === root) return evaluateTask(agent); }).catch((error) => { if (process.cwd() !== root) return; const current = fresh(t); if (current && current.revision === sessionJournal().current(current.conversation)?.revision) { taskState(current, { status: "blocked", reason: `controller-error:${String(error)}` }); publish(current, `任务控制失败并已停止自动执行：${String(error)}`); } }).finally(() => resolving.delete(k));
  resolving.set(k, job);
}
export async function waitTaskResolution() { await Promise.allSettled([...resolving.values()]); }
async function launchAttempt(id: string, conversation: string) {
  const root = process.cwd();
  const j = sessionJournal(), deps = getHandlerDeps(); let t = j.current(conversation)?.work?.[id];
  if (!t || t.revision !== j.current(conversation)?.revision || t.status !== "retry_wait" || (t.mode !== "auto" && !t.retryRequested)) return;
  if (deps.killedAgents.has(conversation) || !deps.agents.has(conversation)) return; // Remains durable until PM starts again.
  await waitForSessionControl(t.parent);
  await cancelAgentToolsAndWait(t.latestAgent);
  if (process.cwd() !== root) return;
  t = j.current(conversation)?.work?.[id]; if (!t || t.revision !== j.current(conversation)?.revision || t.status !== "retry_wait" || (t.mode !== "auto" && !t.retryRequested)) return;
  if (Date.now() >= t.deadline) { taskState(t, { status: "exhausted", reason: "task-deadline" }); publish(t, "任务总时限已到，停止续派。"); return; }
  const blocker = safeToRetry(t); if (blocker) { taskState(t, { status: "blocked", reason: blocker }); publish(t, blocker); return; }
  const conflicts = (await workspaceChanges(t)).filter((r) => r.current !== r.before && r.current !== r.after).map((r) => r.path);
  if (conflicts.length) { taskState(t, { status: "blocked", reason: "workspace-conflict-before-retry", workspace: { ...t.workspace!, status: "conflict", conflicts } }); publish(t, `续派前检测到文件冲突，保留双方修改并停止：${conflicts.join(", ")}`); return; }
  t = j.current(conversation)?.work?.[id]; if (!t || t.revision !== j.current(conversation)?.revision || t.status !== "retry_wait") return;
  let parent = t.parent;
  while (j.binding(parent)?.parent && (!deps.agents.has(parent) || ["done", "err"].includes(getState().agents.get(parent)?.state ?? ""))) parent = j.binding(parent)!.parent!;
  if (parent !== t.parent) { taskState(t, { parent }); t = fresh(t)!; }
  const child = `${t.attempts[0] ?? t.latestAgent}-retry-${t.attempts.length + 1}`;
  const event: Extract<TuiEvent, { type: "spawn" }> = { v: 1, type: "spawn", parent, child, role: "Worker", goal: t.goal, dispatch: t.dispatch, session_revision: t.revision };
  const check = deps.pm.preCheckSpawn(event, "Leader");
  if (!check.ok) {
    if (check.code === "fanout_exceeded" || check.code === "duplicate_goal") { taskState(t, { reason: `capacity-wait:${check.code}`, nextAt: Math.min(t.deadline, Date.now() + 1000) }); armTask(fresh(t)!); }
    else { taskState(t, { status: "blocked", reason: `dispatch-policy:${check.code}` }); publish(t, `当前组织策略不允许自动续派：${check.detail}。请 PM 调整负责人安排，预算保留。`); }
    return;
  }
  try { reserveAttempt(t, child); } catch (error) { publish(t, String(error)); return; }
  const previous = j.binding(t.latestAgent), receipts = Object.values(t.operations).map(({ agent, name, status, ok, guard }) => ({ agent, name, status, ok, guard }));
  applyEvent(event); deps.pm.observe(event);
  startWorker(event, { firstMessage: `继续同一逻辑任务 ${t.id}，这是 ${t.attempts.length + 1}/${t.maxAttempts} 次尝试，不得重新做已确认完成的工作。\n目标：${t.goal}\n续派方案：${t.reason}\n上次停止：${JSON.stringify(previous?.outcome)}\n已完成操作凭据：${JSON.stringify(receipts)}\n先 Read 核对现场，仅完成剩余事项并验收。已确认写入会按凭据去重；命令副作用不确定时必须交接。` });
}
export function recoverTasks(conversation: string) {
  const j = sessionJournal();
  for (const t of workItems(j, conversation).filter((w) => w.revision === j.current(conversation)?.revision)) {
    if (t.status === "retry_wait") armTask(t);
    else if (["running", "evaluating"].includes(t.status)) {
      const b = j.binding(t.latestAgent);
      if (b?.outcome) queueTaskResolution(b.id);
      else if (!getHandlerDeps().agents.has(t.latestAgent)) { taskState(t, { status: "blocked", reason: "reserved-attempt-interrupted" }); publish(t, "派工预约后进程中断，次数已计入预算；核对后可 TaskRetry，避免重复启动。"); }
    }
  }
}
function owned(requester: string, id: string) {
  const j = sessionJournal(), b = j.binding(requester), t = b && j.current(b.conversation)?.work?.[id];
  if (!b || b.role !== "Leader" || !t || t.revision !== j.current(b.conversation)?.revision || (requester !== t.conversation && requester !== t.parent)) throw new Error("Only the current task owner/root PM may control this task");
  return t;
}
export function retryTask(requester: string, id: string, reason: string) {
  const t = owned(requester, id);
  if (!["blocked", "awaiting_review"].includes(t.status)) throw new Error(`Task is ${t.status}; cannot start another concurrent/accepted/exhausted attempt`);
  if (!reason.trim()) throw new Error("Retry requires a concrete revised plan/reason");
  scheduleRetry(t, `pm-plan:${reason.slice(0, 1500)}`, true); return fresh(t)!;
}
export function taskMode(requester: string, id: string, mode: "auto" | "manual") {
  const t = owned(requester, id); taskState(t, { mode, retryRequested: false }); if (mode === "auto" && t.status === "retry_wait") armTask(fresh(t)!); return fresh(t)!;
}
export function reconcileTask(requester: string, id: string, operation: string, evidence: string[], reason: string) {
  const t = owned(requester, id), j = sessionJournal(), op = t.operations[operation], last = j.binding(t.latestAgent)?.outcome;
  const acceptance = operation.includes(`:accept-${t.id}-`) && j.current(t.conversation)?.tools[operation];
  if (acceptance && acceptance.name === "RunTests" && acceptance.status === "uncertain") {
    if (t.status !== "blocked" || !reason.trim() || !evidence.length || evidence.some((id) => { const p = j.current(t.conversation)?.tools[`${requester}:${id}`]; return !p?.ok || p.verifiedExecution !== true || p.name !== "RunTests" || (p.args as any)?.strict !== true || (p.completedSeq ?? 0) <= (last?.seq ?? 0) || checkedDirectory(String((p.args as any)?.project_dir ?? ".")) !== checkedDirectory(String((acceptance.args as any)?.project_dir ?? ".")); })) throw new Error("Interrupted acceptance requires a fresh successful independent strict PM RunTests proof");
    j.append("task.acceptance.reconciled", t.conversation, requester, t.revision, { id: t.id, key: operation, evidence, reason: reason.slice(0, 1500) }); return fresh(t)!;
  }
  if (t.status !== "blocked" || !op?.mutation || !reason.trim() || !evidence.length) throw new Error("Reconciliation requires a blocked task, mutation operation, inspection evidence and a do-not-repeat rationale");
  if (evidence.some((id) => { const proof = j.current(t.conversation)?.tools[`${requester}:${id}`]; return !proof || !proof.ok || proof.verifiedExecution !== true || proof.status !== "completed" || (proof.completedSeq ?? 0) <= Math.max(last?.seq ?? 0, op.startedSeq ?? 0) || !["Read", "Grep", "WebFetch", "Bash", "RunTests", "TypeCheck"].includes(proof.name); })) throw new Error("Reconciliation requires fresh successful independent PM inspection tool call IDs");
  const guard = op.path ? (() => { const f = checkedFile(agentFile(t.latestAgent, op.path!)); return { path: f.path, sha256: f.sha256 }; })() : undefined;
  j.append("task.operation.reconciled", t.conversation, requester, t.revision, { id: t.id, key: operation, guard, reconciliation: { reviewer: requester, evidence, reason: reason.slice(0, 1500), at: Date.now() } });
  return fresh(t)!;
}
export function reviewTask(requester: string, id: string, verdict: "accept" | "reject", evidence: string[], rationale: string) {
  const t = owned(requester, id), j = sessionJournal(), b = j.binding(t.latestAgent);
  if (!["awaiting_review", "blocked"].includes(t.status) || !b?.outcome?.reportedSuccess) throw new Error("Independent review requires a stopped task which self-reported success");
  if (!rationale.trim() || !evidence.length || evidence.some((callId) => { const proof = j.current(t.conversation)?.tools[`${requester}:${callId}`]; return !proof || proof.status !== "completed" || !proof.ok || proof.verifiedExecution !== true || (t.workspace && (proof.args as any)?.task !== t.id) || (proof.completedSeq ?? 0) <= b.outcome!.seq || !["Read", "Grep", "RunTests", "TypeCheck"].includes(proof.name); })) throw new Error("Review requires fresh successful independent PM Read/Grep/RunTests/TypeCheck tool call IDs after the latest Worker stopped, and rationale");
  if (verdict === "accept") {
    if (b.outcome.remaining.length || Object.values(t.operations).some((op) => op.mutation && !op.reconciliation && (op.status !== "completed" || !op.ok))) throw new Error("Unresolved effects or unfinished items prevent acceptance");
    for (const check of t.checks) {
      if (check.type === "test_suite") {
        const strictProof = evidence.some((id) => { const p = j.current(t.conversation)?.tools[`${requester}:${id}`]; return p?.name === "RunTests" && (p.args as any)?.strict === true && checkedDirectory(String((p.args as any).project_dir ?? "."), workspacePath(t)) === checkedDirectory(check.path, workspacePath(t)); });
        if (!strictProof && !t.verdict?.details.some((d) => d.startsWith(`PASS criterion=${check.criterion} test_suite ${check.path}:`))) throw new Error("Cannot override failing deterministic test suite");
      } else { const f = checkedFile(check.path, workspacePath(t)); if (check.type === "file_sha256" ? f.sha256 !== check.value!.toLowerCase() : !f.bytes.toString("utf8").includes(check.value!)) throw new Error("Cannot override failing deterministic acceptance checks"); }
    }
  }
  const result = { passed: verdict === "accept", details: [rationale.slice(0, 1500), ...evidence.map((e) => `proof:${requester}:${e}`)], at: Date.now(), reviewer: requester };
  if (verdict === "accept") { taskState(t, { status: "accepted", reason: "pm-independent-review", verdict: result }); publish(t, "PM 独立验收已通过，任务关闭。"); }
  else { taskState(t, { verdict: result }); scheduleRetry(fresh(t)!, "acceptance-rejected"); }
  return fresh(t)!;
}
