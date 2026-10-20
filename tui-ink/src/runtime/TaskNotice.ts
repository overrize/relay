import { sessionJournal } from "../session/Journal.js";
import { getState } from "../store.js";
import { HttpConvAgent } from "../adapters/httpAgent.js";
import { queueTaskResolution } from "./TaskRecovery.js";
export function taskNotice(parent: string, child: string, text: string, agents: Map<string, HttpConvAgent>, killed: Set<string>) {
  const j = sessionJournal(), task = j.binding(child); let owner = j.binding(parent);
  if (!task || !owner || !j.isCurrent(child, task.revision) || !j.isCurrent(parent, task.revision)) return;
  // An unavailable coordinator must not become a dead-end for its descendants.
  for (let depth = 0; owner?.parent && depth < 8; depth++) {
    if (agents.has(parent) && !killed.has(parent) && !["done", "err"].includes(getState().agents.get(parent)?.state ?? "")) break;
    parent = owner.parent; owner = j.binding(parent);
  }
  if (!owner || !j.isCurrent(parent, task.revision)) return;
  if (task.outcome) queueTaskResolution(child);
  const id = `task:${parent}:${child}:${task.revision}:${task.outcome?.seq ?? j.sequence().seq}`;
  const detail = task.outcome ? `\n持久交接记录：${JSON.stringify(task.outcome)}\n可用 TaskStatus 查询，不要把自报完成等同于独立验收。` : "";
  j.acceptNotice(parent, id, text + detail, task.revision); // Persist even if the parent is not currently running.
  const instance = agents.get(parent);
  // Root PM is a continuing conversation: an idle/completed turn must not hide
  // child results. A completed coordinator task is not automatically revived.
  if (!killed.has(parent) && (!owner.parent || getState().agents.get(parent)?.state !== "done") && instance instanceof HttpConvAgent) instance.receiveRuntimeNotice(id, text + detail, task.revision);
}
