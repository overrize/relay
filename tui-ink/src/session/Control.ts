import { randomUUID } from "node:crypto";
import type { TuiEvent } from "../protocol.js";
import { sessionJournal } from "./Journal.js";
import { cancelAgentToolsAndWait } from "../tools/command.js";
import { recoverOrphanCommands } from "../tools/processRecovery.js";
import { recoverWorkspacePublishes } from "./Workspaces.js";

const live = new Map<string, () => void>();
const settling = new Map<string, Promise<unknown>>();
const recovery = new Map<string, Promise<void>>();
export function beginSessionRecovery(conversation: string): void {
  const root = process.cwd(), key = `${root}\0${conversation}`;
  sessionJournal(root).scheduleMaintenance();
  const task = recoverOrphanCommands(root).then((results) => {
    const journal = sessionJournal(root);
    for (const result of results) journal.append("process.recovered", conversation, conversation, journal.current(conversation)?.revision ?? 0, result);
  }).then(() => recoverWorkspacePublishes());
  recovery.set(key, task);
  void task.catch((error) => process.stderr.write(`[recovery] ${String(error)}\n`));
}
const liveKey = (id: string) => `${process.cwd()}\0${id}`;
export function registerSessionAgent(id: string, invalidate: () => void): () => void {
  const key = liveKey(id); live.set(key, invalidate);
  return () => { if (live.get(key) === invalidate) live.delete(key); };
}
function stopAffected(conversation: string, ids: string[]) {
  for (const id of ids) live.get(liveKey(id))?.();
  const key = liveKey(conversation);
  const barrier = Promise.all([settling.get(key), ...ids.map(cancelAgentToolsAndWait)]);
  settling.set(key, barrier);
  void barrier.then(() => { if (settling.get(key) === barrier) settling.delete(key); }, () => {});
}
export function interruptSession(agent:string){
  const j=sessionJournal(),b=j.binding(agent);if(!b)return;
  const current=j.current(b.conversation)!;
  const ids=j.tasks(b.conversation).filter(t=>t.revision===current.revision).map(t=>t.id);
  j.append('requirement.changed',b.conversation,agent,current.revision+1,{text:current.goal,previousRevision:current.revision,preserveProgress:true,reason:'user-interrupted'});
  stopAffected(b.conversation,[agent,...ids]);
}
export async function waitForSessionControl(agent: string) {
  const binding = sessionJournal().binding(agent);
  if (binding) await Promise.all([recovery.get(liveKey(binding.conversation)), settling.get(liveKey(binding.conversation))]);
  await recoverOrphanCommands();
}

export function inputKind(text: string): "change" | "query" | "continue" | "constraint" {
  if (/^\/constraint\s/i.test(text)) return "constraint";
  if (/^\/(?:revise|goal)\s/i.test(text)) return "change";
  if (/^(继续|接着做|恢复|continue\b|resume\b)[。！!\s]*$/i.test(text)) return "continue";
  if (/^(请|帮我|修改|改成|改为|换成|停止|取消|不要|先别|实现|创建|把|change\b|stop\b|cancel\b|implement\b|build\b|use\b)/i.test(text)) return "change";
  if (/[?？]|^(为什么|怎么|如何|是否|能否|有没有|你觉得|讨论|探讨|解释|说明|what\b|how\b|why\b|status\b|progress\b)/i.test(text) || /^(进度|到哪了|好了没|结论呢)[。！!\s]*$/.test(text)) return "query";
  // Unclassified instructions supersede work conservatively. /revise is explicit.
  return "change";
}

export function acceptSessionInput(agent: string, original: string, inputId: string = randomUUID(),kindOverride?:'change'|'query'|'continue'|'constraint') {
  const journal = sessionJournal(), binding = journal.binding(agent);
  if (!binding) throw new Error(`No session binding for ${agent}`);
  let state = journal.current(binding.conversation)!;
  const prior = state.inputs.find((i) => i.id === inputId);
  if (prior) { journal.dispatched(inputId); return prior; }
  const kind = kindOverride ?? inputKind(original.trim());
  const text = original.replace(/^\/(?:revise|goal|constraint)\s+/i, "").trim();
  const affected = journal.tasks(binding.conversation).filter((a) => a.revision === state.revision && (a.status === "running" || a.status === "interrupted"));
  if (kind === "change" || !state.goal) {
    journal.append("requirement.changed", binding.conversation, agent, state.revision + 1, { text, previousRevision: state.revision });
    // Durably invalidate first, then stop runtime work before accepting new execution.
    stopAffected(binding.conversation, [binding.id, ...affected.map((a) => a.id)]);
    state = journal.current(binding.conversation)!;
  }
  if (kind === "constraint") {
    journal.append("constraint.added", binding.conversation, agent, state.revision, { text });
    // A new constraint also invalidates work that did not know it.
    journal.append("requirement.changed", binding.conversation, agent, state.revision + 1, { text: state.goal, previousRevision: state.revision });
    stopAffected(binding.conversation, [binding.id, ...affected.map((a) => a.id)]);
    state = journal.current(binding.conversation)!;
  }
  const event = journal.append("input.accepted", binding.conversation, agent, state.revision, { text, inputId, kind });
  journal.dispatched(inputId);
  return { id: inputId, text, revision: event.revision, status: "pending" as const };
}

/** All accepted runtime events share the durable log and revision fence. */
export function recordSessionEvent(event: TuiEvent): boolean {
  const agent = "agent" in event ? event.agent : event.type === "spawn" ? event.parent : undefined;
  if (!agent) return true;
  const journal = sessionJournal(), binding = journal.binding(agent);
  if (!binding) return true;
  const revision = event.session_revision ?? binding.revision;
  if (!journal.isCurrent(agent, revision)) {
    journal.append("event.rejected", binding.conversation, agent, revision, { type: event.type, reason: "superseded_revision" });
    return false;
  }
  if(event.type==='agent.done'&&(typeof event.success!=='boolean'||event.evidence!==undefined&&(!Array.isArray(event.evidence)||!event.evidence.every(item=>typeof item==='string')))){
    journal.append('event.rejected',binding.conversation,agent,revision,{type:event.type,reason:'invalid_agent_done_payload'});return false;
  }
  journal.append("runtime.event", binding.conversation, agent, revision, event);
  return true;
}
