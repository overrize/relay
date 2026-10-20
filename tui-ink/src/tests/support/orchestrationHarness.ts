/**
 * Shared QA harness: wires REAL components (parser → spawn gate → store →
 * ProcessManager → SecretaryProxy) the way src/index.tsx routes events today.
 *
 * Used by:
 *   - baseline/orchestration-golden.test.ts (M1-5 characterization snapshots)
 *   - eval/scenario-eval.test.ts            (M3-2 scenario eval cases)
 *
 * Not a behavior model — every routed event passes through production code.
 * Callers are responsible for cwd isolation (SecretaryProxy writes .spawn/).
 */

import { parseAgentOutput } from "../../protocol/normalizer.js";
import { applyEvent, ensureAgent, getState } from "../../store.js";
import { ProcessManager } from "../../pm/ProcessManager.js";
import { SecretaryProxy } from "../../memory/SecretaryProxy.js";
import { createMemory } from "../../memory/MemoryStore.js";
import type { TuiEvent, DispatchSpec } from "../../protocol.js";

export function fmt(ev: TuiEvent): string {
  switch (ev.type) {
    case "todo.set":
      return `todo.set ${ev.agent} [${ev.items.map((i) => `${i.state}:${i.text}`).join("|")}]`;
    case "step":
      return `step ${ev.agent} "${ev.text}"`;
    case "tool.call":
      return `tool.call ${ev.agent} ${ev.name}#${ev.id}${ev.needs_approval ? " needs_approval" : ""}`;
    case "tool.result":
      return `tool.result ${ev.agent} #${ev.id} ${ev.ok ? "ok" : "fail"}`;
    case "message":
      return `message ${ev.agent}→${ev.to} "${ev.text.slice(0, 48)}"${(ev as any)._fallback ? " (fallback)" : ""}`;
    case "spawn":
      return `spawn ${ev.parent}→${ev.child} ${ev.role} goal="${ev.goal}"`;
    case "agent.done":
      return `agent.done ${ev.agent} ${ev.success ? "success" : "fail"}`;
    case "agent.error":
      return `agent.error ${ev.agent} ${ev.code}`;
    case "agent.state":
      return `agent.state ${ev.agent} ${ev.state}`;
    case "unit.handup":
      return `unit.handup ${ev.agent}→${ev.parent} facts=${ev.facts_to_promote?.length ?? 0}`;
    case "pm.alert":
      return `alert ${ev.severity} ${ev.code} ${ev.agent}`;
    case "memory.snapshot":
      return `memory.snapshot ${ev.agent}`;
    default:
      return ev.type;
  }
}

export class Timeline {
  readonly entries: string[] = [];
  readonly pm = new ProcessManager("hierarchical");
  private readonly secretaries: SecretaryProxy[] = [];

  constructor() {
    // index.tsx subscribes ProcessManager "event" and applies pm.alert to the store.
    this.pm.on("event", (ev: TuiEvent) => {
      if (ev.type === "pm.alert") {
        this.entries.push(fmt(ev));
        applyEvent(ev);
      }
    });
  }

  /** Boot the permanent PM agent, as index.tsx does at startup. */
  boot(): void {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
  }

  /** Attach a real SecretaryProxy for an agent (writes under caller's cwd). */
  attachSecretary(agentId: string, agentType: "PM" | "LEADER" | "WORKER", depth: number): SecretaryProxy {
    const sec = new SecretaryProxy(
      createMemory({
        agentId, agentType,
        parentChain: [], depth, model: "test", roleName: agentType,
      }),
    );
    this.secretaries.push(sec);
    return sec;
  }

  /** Feed raw LLM output text through the real parser, routing like index.tsx. */
  feed(agentId: string, raw: string): void {
    parseAgentOutput(raw, agentId, (ev) => this.route(ev));
  }

  /** Route a single event: spawn gate → store → PM observe → secretaries. */
  route(ev: TuiEvent): void {
    this.entries.push(fmt(ev));
    if (ev.type === "spawn") {
      const parentRole = getState().agents.get(ev.parent)?.role;
      const check = this.pm.preCheckSpawn(ev, parentRole);
      if (!check.ok) {
        this.entries.push(`gate✗ ${check.code}`);
        return; // index.tsx drops rejected spawns; alert already recorded
      }
      this.entries.push(`gate✓ ${ev.child}`);
    }
    applyEvent(ev);
    this.pm.observe(ev);
    for (const sec of this.secretaries) sec.observe(ev);
  }

  destroy(): void {
    this.pm.destroy();
    for (const sec of this.secretaries) sec.destroy();
  }
}

export const DISPATCH: DispatchSpec = {
  background: "golden baseline task",
  constraints: [],
  acceptance_criteria: ["assertions pass"],
  stop_conditions: ["done"],
};
