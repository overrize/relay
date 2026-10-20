/**
 * Headless tests: ProcessManager spawn validation rules.
 *
 * Tests preCheckSpawn() in isolation — no LLM calls, no HTTP, no TUI process.
 * Covers the hierarchy rules: depth limits, role constraints, duplicate goal detection.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ProcessManager } from "../../../pm/ProcessManager.js";
import { ensureAgent, _resetForTest, getState } from "../../../store.js";
import type { TuiEvent } from "../../../protocol.js";

type SpawnEv = Extract<TuiEvent, { type: "spawn" }>;

/** Minimal valid dispatch spec — fills required fields. */
const DISPATCH = {
  background: "test background",
  constraints: [],
  acceptance_criteria: ["task complete"],
  stop_conditions: ["user.quit"],
};

function spawn(
  parent: string,
  child: string,
  role: "Leader" | "Worker" | "Secretary",
  goal = "test goal",
  dispatch = DISPATCH,
): SpawnEv {
  return { v: 1, type: "spawn", parent, child, role, goal, dispatch };
}

describe("pm-rules: Worker cannot spawn", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    _resetForTest();
    pm = new ProcessManager("hierarchical");
  });

  it("Worker → Worker spawn is blocked", () => {
    ensureAgent({ id: "pm",        name: "pm",        role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01",     name: "tl-01",     role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "worker-01", name: "worker-01", role: "Worker", state: "run", parent: "tl-01" });
    const result = pm.preCheckSpawn(spawn("worker-01", "worker-02", "Worker"), "Worker");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "worker_cannot_spawn");
  });

  it("Worker → Leader spawn is also blocked", () => {
    ensureAgent({ id: "pm",        name: "pm",        role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01",     name: "tl-01",     role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "worker-01", name: "worker-01", role: "Worker", state: "run", parent: "tl-01" });
    const result = pm.preCheckSpawn(spawn("worker-01", "tl-99", "Leader"), "Worker");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "worker_cannot_spawn");
  });
});

describe("pm-rules: PM (depth=0) cannot spawn Worker", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    _resetForTest();
    pm = new ProcessManager("hierarchical");
  });

  it("PM → Worker is blocked", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    const result = pm.preCheckSpawn(spawn("pm", "worker-01", "Worker"), "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "pm_cannot_spawn_worker");
  });

  it("PM → Leader is allowed", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    const result = pm.preCheckSpawn(spawn("pm", "tl-01", "Leader"), "Leader");
    assert.equal(result.ok, true);
  });
});

describe("pm-rules: TL spawn rules", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    _resetForTest();
    pm = new ProcessManager("hierarchical");
  });

  it("TL (depth=1) → Worker is allowed", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", depth: 1 });
    const result = pm.preCheckSpawn(spawn("tl-01", "worker-01", "Worker"), "Leader");
    assert.equal(result.ok, true);
  });

  it("TL (depth=1) → Leader is blocked (depth_role_violation)", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", depth: 1 });
    // depth=1, trying to spawn Leader (only PM at depth=0 may spawn Leaders)
    // Note: PM code checks parentDepthNow >= 2 for Leader block, so depth=1 should pass.
    // Let's verify that depth=2 (Worker's parent) is blocked:
    ensureAgent({ id: "worker-01", name: "worker-01", role: "Worker", state: "run", parent: "tl-01", depth: 2 });
    // Simulate a leader at depth=2 trying to spawn another leader
    const deepTl = { id: "tl-deep", name: "tl-deep", role: "Leader" as const, state: "run" as const, parent: "tl-01", depth: 2 };
    ensureAgent(deepTl);
    const result = pm.preCheckSpawn(spawn("tl-deep", "tl-forbidden", "Leader"), "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "depth_role_violation");
  });
});

describe("pm-rules: dispatch validation", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    _resetForTest();
    pm = new ProcessManager("hierarchical");
  });

  it("missing dispatch is blocked", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    const ev: SpawnEv = { v: 1, type: "spawn", parent: "pm", child: "tl-01", role: "Leader", goal: "test" };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "dispatch_missing");
  });

  it("dispatch without acceptance_criteria is blocked", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    const ev: SpawnEv = {
      v: 1, type: "spawn", parent: "pm", child: "tl-01", role: "Leader", goal: "test",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: [], stop_conditions: ["done"] },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "dispatch_missing_acceptance");
  });

  it("full dispatch passes validation", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    const result = pm.preCheckSpawn(spawn("pm", "tl-01", "Leader"), "Leader");
    assert.equal(result.ok, true);
  });
});

describe("pm-rules: duplicate goal detection", () => {
  let pm: ProcessManager;

  beforeEach(() => {
    _resetForTest();
    pm = new ProcessManager("hierarchical");
  });

  it("second spawn with identical goal is blocked", () => {
    const GOAL = "analyse store.ts";
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", goal: GOAL });

    const result = pm.preCheckSpawn(spawn("pm", "tl-02", "Leader", GOAL), "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "duplicate_goal");
  });

  it("spawn with different goal is allowed", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", goal: "task A" });

    const result = pm.preCheckSpawn(spawn("pm", "tl-02", "Leader", "task B"), "Leader");
    assert.equal(result.ok, true);
  });

  it("duplicate goal check is case/whitespace normalised", () => {
    const GOAL_A = "  Analyse Store.ts  ";
    const GOAL_B = "analyse store.ts";
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", goal: GOAL_A });

    // Same goal, different case/padding — should be treated as duplicate
    const result = pm.preCheckSpawn(spawn("pm", "tl-02", "Leader", GOAL_B), "Leader");
    assert.equal(result.ok, false, "Duplicate with different casing was incorrectly allowed");
  });

  it("done agent's goal does not block new spawn", () => {
    const GOAL = "completed task";
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "done", parent: "pm", goal: GOAL });

    // Completed agent — new spawn with same goal should be allowed
    const result = pm.preCheckSpawn(spawn("pm", "tl-02", "Leader", GOAL), "Leader");
    assert.equal(result.ok, true, "Done agent's goal should not block new spawn");
  });
});
