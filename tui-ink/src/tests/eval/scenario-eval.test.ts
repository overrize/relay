/**
 * M3-2 · Scenario eval set — seed batch (EV-001..EV-010, target ≥30 by M3).
 *
 * Outcome-focused acceptance cases driving REAL components via the shared
 * harness (parser → gate → store → ProcessManager → Secretary). Complements
 * the M1-5 golden baseline: golden pins exact event timelines (regression),
 * eval asserts end-state outcomes (capability acceptance) — categories map to
 * WORKPLAN M3-2: 协议遵守 / 治理 / 收敛 / 记忆质量 / 审批.
 *
 * BC-001 section: pins the *trigger condition* of the plan-only-first-turn
 * bad case (the part testable pre-split) and registers post-M1-6e specs as
 * it.todo so the deferred coverage stays visible in every test run.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { approve, ensureAgent, getState, getSessionTokens, pruneAgents, _resetForTest } from "../../store.js";
import { loadMemory, loadMessages } from "../../memory/MemoryStore.js";
import { executeTool } from "../../tools/registry.js";
import type { TuiEvent } from "../../protocol.js";
import { decideAgentIdleAfterNoTools, isActionEventType } from "../../runtime/OrchestratorRuntime.js";
import { metricTypeForAlert } from "../../pm/ProcessManager.js";
import { Timeline, DISPATCH } from "../support/orchestrationHarness.js";

let tmpDir: string;
let origCwd: string;
before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-eval-"));
  process.chdir(tmpDir);
});
after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let t: Timeline;
beforeEach(() => { _resetForTest(); t = new Timeline(); t.boot(); });
afterEach(() => t.destroy());

const dispatchJson = JSON.stringify(DISPATCH);

describe("EV·协议遵守", () => {
  it("EV-001 合规多事件轮零 fallback、全部入 store", () => {
    t.feed("pm", [
      `{"type":"message","to":"user","text":"开始处理"}`,
      ``,
      `{"type":"spawn","parent":"pm","child":"tl-1","role":"Leader","goal":"任务A","dispatch":${dispatchJson}}`,
    ].join("\n"));
    assert.equal(t.entries.some((e) => e.includes("(fallback)")), false);
    assert.equal(getState().agents.get("tl-1")?.state, "idle");
  });

  it("EV-009 修复管线抢救的事件仍正常入 store（协议韧性）", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    // 非法转义 + 缺右括号，双重损坏
    t.feed("tl-1", `{"type":"message","to":"user","text":"第一行\n第二行"`);
    const msgs = getState().messagesByAgent.get("tl-1") ?? [];
    assert.equal(msgs.some((m) => m.text.includes("第一行")), true);
  });
});

describe("EV·治理", () => {
  it("EV-002 PM 直接 spawn Worker 被拒且不产生 agent", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "w-x", role: "Worker", goal: "越级", dispatch: DISPATCH });
    assert.equal(getState().agents.has("w-x"), false);
    assert.equal(t.pm.getAlerts().some((a) => a.code === "pm_cannot_spawn_worker"), true);
  });

  it("EV-003 归一化后的重复 goal 被拒", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-a", role: "Leader", goal: "修复 BUG", dispatch: DISPATCH });
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-b", role: "Leader", goal: "修复  bug", dispatch: DISPATCH });
    assert.equal(getState().agents.has("tl-a"), true);
    assert.equal(getState().agents.has("tl-b"), false);
  });

  it("EV-004 worker 越权 message→user 触发通信矩阵告警", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "tl-1" });
    t.route({ v: 1, type: "message", agent: "w-1", to: "user", text: "直接汇报" });
    assert.equal(t.pm.getAlerts().some((a) => a.code === "illegal_message" && a.agent === "w-1"), true);
  });
});

describe("EV·收敛", () => {
  it("EV-005 终态后 idle 不复活（done 保持 done）", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    t.route({ v: 1, type: "agent.done", agent: "w-1", success: true, reason: "done" });
    t.route({ v: 1, type: "agent.state", agent: "w-1", state: "idle" });
    assert.equal(getState().agents.get("w-1")?.state, "done");
  });
});

describe("EV·记忆质量", () => {
  it("EV-006 中文近似 fact 独立保留，避免吞掉条件或否定", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "tool.result", agent: "tl-1", id: "t1", ok: true, output: "配置文件在 src/config.ts，需要保留 baseUrl" });
    t.route({ v: 1, type: "tool.result", agent: "tl-1", id: "t2", ok: true, output: "src/config.ts 的配置文件必须保留 baseUrl" });
    const facts = sec.getMemory().working_set.facts;
    assert.equal(facts.length, 2);
    assert.equal(facts[0]!.weight, 1);
  });

  it("EV-007 btw 旁路信息入 fact", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "message", agent: "pm", to: "tl-1", text: "btw: 部署窗口是周五" });
    assert.equal(sec.getMemory().working_set.facts.some((f) => f.text.includes("部署窗口")), true);
  });
});

describe("EV·审批", () => {
  it("EV-008 破坏性 Bash 进审批队列，approve 后清空且标记", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    t.route({ v: 1, type: "tool.call", agent: "w-1", id: "b1", name: "Bash",
              args: { command: "rm -rf dist" }, needs_approval: true });
    assert.equal(getState().pendingApprovals.length, 1);
    approve("b1");
    assert.equal(getState().pendingApprovals.length, 0);
    assert.equal(getState().messagesByAgent.get("w-1")!.find((m) => m.tool_id === "b1")?.approved, true);
  });
});

describe("EV·治理·扩展", () => {
  it("EV-014 fanout 上限阻止第 N+1 个 RUNNING 子节点", () => {
    t.pm.setFanout(2);
    for (const [c, g] of [["tl-a", "任务甲"], ["tl-b", "任务乙"]] as const) {
      t.route({ v: 1, type: "spawn", parent: "pm", child: c, role: "Leader", goal: g, dispatch: DISPATCH });
      t.route({ v: 1, type: "agent.state", agent: c, state: "run" });
    }
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-c", role: "Leader", goal: "任务丙", dispatch: DISPATCH });
    assert.equal(getState().agents.has("tl-c"), false);
    assert.equal(t.pm.getAlerts().some((a) => a.code === "fanout_exceeded"), true);
  });

  it("EV-015 depth≥2 的 agent 不能 spawn Leader", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "mid", name: "mid", role: "Leader", state: "run", parent: "tl-1" });
    t.route({ v: 1, type: "spawn", parent: "mid", child: "deep", role: "Leader", goal: "过深", dispatch: DISPATCH });
    assert.equal(getState().agents.has("deep"), false);
    assert.equal(t.pm.getAlerts().some((a) => a.code === "depth_role_violation"), true);
  });
});

describe("EV·收敛·扩展", () => {
  it("EV-016 worker 报错终态后 idle 不复活（保持 err）", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    t.route({ v: 1, type: "agent.error", agent: "w-1", code: "http_error", detail: "boom" });
    t.route({ v: 1, type: "agent.state", agent: "w-1", state: "idle" });
    assert.equal(getState().agents.get("w-1")?.state, "err");
  });

  it("EV-017 unit.handup 的 facts_to_promote 落入该 agent 自己的 Secretary 记忆", () => {
    // 语义澄清（评审反馈）：SecretaryProxy.observe 对 unit.handup 的处理是
    // `if (ev.agent === id)` → 提升到「发出 handup 的这个 agent 自己」的 working_set，
    // 不是父节点聚合。父级聚合走 ingestChildMemory，见 EV-031。
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "unit.handup", agent: "tl-1", parent: "pm",
      summary: "子任务完成", artifacts: [],
      facts_to_promote: ["模块 A 用单例", "配置走环境变量"], decisions: [], failed_acceptance: [] } as TuiEvent);
    const texts = sec.getMemory().working_set.facts.map((f) => f.text);
    assert.equal(texts.some((x) => x.includes("单例")), true);
    assert.equal(texts.some((x) => x.includes("环境变量")), true);
  });

  it("EV-031 父级聚合：PM Secretary.ingestChildMemory 吸收子 TL 记忆（带来源前缀）", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const pmSec = t.attachSecretary("pm", "PM", 0);
    const tlSec = t.attachSecretary("tl-1", "LEADER", 1);
    // 子 TL 产生一条事实（tool.result 只写 ev.agent===id 的 secretary，pmSec 不误收）
    t.route({ v: 1, type: "tool.result", agent: "tl-1", id: "t1", ok: true, output: "子任务关键结论 Z" });
    assert.equal(pmSec.getMemory().working_set.facts.length, 0, "聚合前 PM 不含子事实");
    // 显式父级聚合
    pmSec.ingestChildMemory(tlSec.getMemory());
    const pmFacts = pmSec.getMemory().working_set.facts.map((f) => f.text);
    assert.equal(pmFacts.some((x) => x.includes("结论 Z")), true);
    assert.equal(pmFacts.some((x) => x.startsWith("[tl-1]")), true, "聚合的事实带子节点来源前缀");
  });

  it("EV-018 done 后完成的 todo 项落 decisions", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "todo.set", agent: "tl-1", items: [
      { id: "1", text: "评审设计", state: "done" }, { id: "2", text: "实现", state: "run" },
    ] });
    assert.equal(sec.getMemory().working_set.decisions.some((d) => d.text.includes("评审设计")), true);
  });
});

describe("EV·UI 状态·扩展", () => {
  it("EV-019 prune 目标子树隐藏而非删除（pm 免疫）", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "done", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "done", parent: "tl-1" });
    const n = pruneAgents("tl-1");
    assert.ok(n >= 2);
    assert.equal(getState().agents.get("tl-1")?.hidden, true);
    assert.equal(getState().agents.get("w-1")?.hidden, true);
    assert.equal(getState().agents.get("pm")?.hidden, undefined); // pm 永不隐藏
  });

  it("EV-020 spawn 事件自动聚焦新子节点（当前聚焦在父）", () => {
    // 选中 pm，spawn tl-1 → 自动切到 tl-1
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-1", role: "Leader", goal: "聚焦测试", dispatch: DISPATCH });
    assert.equal(getState().selectedAgent, "tl-1");
  });
});

describe("EV·记忆持久化·扩展", () => {
  it("EV-021 done 后 tombstone 写 final_status 与 compact_summary，落盘可重载", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    t.route({ v: 1, type: "tool.result", agent: "tl-1", id: "t1", ok: true, output: "关键事实 X" });
    t.route({ v: 1, type: "agent.done", agent: "tl-1", success: true, reason: "全部完成" });
    assert.equal(sec.getMemory().tombstone.final_status, "done");
    assert.equal(sec.getMemory().tombstone.compact_summary?.startsWith("全部完成"), true);
    const reloaded = loadMemory("tl-1");
    assert.equal(reloaded?.tombstone.final_status, "done");
  });

  it("EV-022 对话消息持久化，loadMessages 可取回", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    const sec = t.attachSecretary("tl-1", "LEADER", 1);
    sec.observeMessage("user", "任务目标：拆分配置");
    sec.observeMessage("assistant", "已理解，开始拆分");
    const msgs = loadMessages("tl-1");
    assert.ok(msgs.length >= 2);
    assert.equal(msgs.some((m) => m.content.includes("拆分配置")), true);
  });

  it("EV-023 agent.error 终态写 tombstone final_status=error", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    const sec = t.attachSecretary("w-1", "WORKER", 2);
    t.route({ v: 1, type: "agent.error", agent: "w-1", code: "http_error", detail: "上游 500" });
    assert.equal(sec.getMemory().tombstone.final_status, "error");
  });
});

describe("EV·观测·扩展", () => {
  it("EV-024 token.usage 累计到 per-agent 与 session", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    t.route({ v: 1, type: "token.usage", agent: "tl-1", prompt: 1200, completion: 300, ttft_ms: 0, total_ms: 0 } as TuiEvent);
    t.route({ v: 1, type: "token.usage", agent: "tl-1", prompt: 800, completion: 200, ttft_ms: 0, total_ms: 0 } as TuiEvent);
    assert.equal(getState().tokensByAgent.get("tl-1")?.prompt, 2000);
    assert.equal(getSessionTokens().total, 2500);
  });

  it("EV-025 tool.call 计入 loop 计数，同路径 10 次触发 tool_call_repeated", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    for (let i = 0; i < 10; i++) {
      t.route({ v: 1, type: "tool.call", agent: "w-1", id: `t${i}`, name: "Read", args: { path: "src/x.ts" } } as TuiEvent);
    }
    assert.equal(t.pm.getAlerts().some((a) => a.code === "loop_suspected"), true);
  });
});

describe("EV·通信矩阵·正例", () => {
  it("EV-026 leader→leader（TL→PM）合法，不产生 illegal_message 告警", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    t.route({ v: 1, type: "message", agent: "tl-1", to: "pm", text: "上报进展" });
    assert.equal(t.pm.getAlerts().some((a) => a.code === "illegal_message"), false);
  });

  it("EV-027 worker→worker 直接通信被拦截告警", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "tl-1" });
    ensureAgent({ id: "w-2", name: "w-2", role: "Worker", state: "run", parent: "tl-1" });
    t.route({ v: 1, type: "message", agent: "w-1", to: "w-2", text: "私聊" });
    assert.equal(t.pm.getAlerts().some((a) => a.code === "illegal_message" && a.agent === "w-1"), true);
  });
});

describe("EV·治理·dispatch 校验", () => {
  it("EV-028 spawn 缺 stop_conditions 被拒", () => {
    t.route({ v: 1, type: "spawn", parent: "pm", child: "tl-x", role: "Leader", goal: "缺停止条件",
      dispatch: { ...DISPATCH, stop_conditions: [] } });
    assert.equal(getState().agents.has("tl-x"), false);
    assert.equal(t.pm.getAlerts().some((a) => a.code === "dispatch_missing_stopcond"), true);
  });

  it("EV-029 相同 goal 但不同父节点不算重复，两者都放行", () => {
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });
    ensureAgent({ id: "tl-2", name: "tl-2", role: "Leader", state: "run", parent: "pm" });
    t.route({ v: 1, type: "spawn", parent: "tl-1", child: "w-a", role: "Worker", goal: "跑测试", dispatch: DISPATCH });
    t.route({ v: 1, type: "spawn", parent: "tl-2", child: "w-b", role: "Worker", goal: "跑测试", dispatch: DISPATCH });
    assert.equal(getState().agents.has("w-a"), true);
    assert.equal(getState().agents.has("w-b"), true);
  });
});

describe("EV·工具", () => {
  it("EV-030 未知工具经 executeTool 返回错误而非抛异常", async () => {
    const r = await executeTool("NoSuchTool", { x: 1 });
    assert.equal(r.ok, false);
    assert.match(r.output, /Unknown tool/);
  });
});

describe("EV·BC-001 首轮只规划不执行", () => {
  it("EV-010 触发条件画像：纯规划轮只产出 todo.set/step，无任何行动事件", () => {
    ensureAgent({ id: "w-1", name: "w-1", role: "Worker", state: "run", parent: "pm" });
    t.feed("w-1", [
      `{"type":"todo.set","items":[{"id":"1","text":"读代码","state":"todo"},{"id":"2","text":"改实现","state":"todo"}]}`,
      ``,
      `{"type":"step","text":"规划完成，准备开始"}`,
    ].join("\n"));
    const ACTION_TYPES = new Set(["tool.call", "spawn", "message", "unit.handup", "agent.done"]);
    const actions = t.entries.filter((e) => ACTION_TYPES.has(e.split(" ")[0]!));
    assert.deepEqual(actions, [], "纯规划轮：0 个行动事件 → 现行 harness 只能靠 nudge 补救（BC-001）");
  });

  it("EV-011 [after M1-6e] 纯规划轮触发 nudge 且写 no_progress_nudge 指标", () => {
    assert.equal(decideAgentIdleAfterNoTools({
      acted: false,
      hasPendingTodos: true,
      continuations: 0,
      gaveUp: false,
    }), "nudge");
    assert.equal(metricTypeForAlert("no_progress"), "no_progress_nudge");
  });

  it("EV-012 [after M1-6e] leader/worker acted 判定统一：纯 todo.set 两侧都不算 acted", () => {
    assert.equal(isActionEventType("todo.set"), false);
    assert.equal(isActionEventType("step"), false);
    assert.equal(isActionEventType("tool.call"), true);
    assert.equal(isActionEventType("spawn"), true);
    assert.equal(isActionEventType("message"), true);
    assert.equal(isActionEventType("unit.handup"), true);
    assert.equal(isActionEventType("agent.done"), true);
  });

  it("EV-013 [after M1-6e] nudge 3 次耗尽后收敛/上报，不无限催", () => {
    assert.equal(decideAgentIdleAfterNoTools({
      acted: false,
      hasPendingTodos: true,
      continuations: 3,
      gaveUp: false,
    }), "hard-circuit");
    assert.equal(decideAgentIdleAfterNoTools({
      acted: false,
      hasPendingTodos: false,
      continuations: 2,
      gaveUp: false,
    }), "silent-hard-circuit");
  });
});
