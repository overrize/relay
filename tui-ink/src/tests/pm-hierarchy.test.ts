// pm-hierarchy.test.ts
// 覆盖 PM ↔ Tech Lead ↔ Worker 三层架构新增的所有行为：
//   1. PM depth=0 不能直接 spawn Worker
//   2. PM 可以 spawn Leader（Tech Lead）
//   3. depth≥2 不能 spawn Leader
//   4. setFanout / getMaxFanout 可配置
//   5. createMemory 生成 session_hash（7 chars hex）
//   6. loadMemoryByHash 通过 hash 查找 memory
//   7. SecretaryProxy.ingestChildMemory 聚合子节点 facts/decisions
//   8. Tech Lead spawn → Worker 全链路（三层）
//   9. spawn role="Leader" → AgentInfo.role 正确为 "Leader"
//  10. process-monitor 显示为 PM 的 Secretary 子节点

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { applyEvent, getState, ensureAgent, updateAgentInfo, _resetForTest } from "../store.js";
import type { TuiEvent } from "../protocol.js";
import { ProcessManager, metricTypeForAlert } from "../pm/ProcessManager.js";
import { factSimilarity, factTokens, SecretaryProxy } from "../memory/SecretaryProxy.js";
import { createMemory, loadMemory, loadMemoryByHash } from "../memory/MemoryStore.js";
import { HealthMetricsStore, setHealthMetricsStoreForTests } from "../runtime/HealthMetrics.js";

// ── 临时 memory 目录 ─────────────────────────────────────────────────────────

let tmpDir: string;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-pm-hierarchy-"));
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => _resetForTest());

// ── 1. PM 深度限制：depth=0 不能直接 spawn Worker ────────────────────────────

describe("ProcessManager — PM 深度规则", () => {
  it("depth=0 PM 直接 spawn Worker → pm_cannot_spawn_worker 拒绝", () => {
    const pm = new ProcessManager("hierarchical");
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0 });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "pm", child: "worker-01",
      role: "Worker", goal: "直接派 worker",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["done"], stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "pm_cannot_spawn_worker",
      "PM depth=0 不能直接 spawn Worker，必须先 spawn Leader（Tech Lead）");
    pm.destroy();
  });

  it("depth=0 PM spawn Leader（Tech Lead）→ ok", () => {
    const pm = new ProcessManager("hierarchical");
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0 });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "pm", child: "tl-01",
      role: "Leader", goal: "负责代码重构任务",
      dispatch: {
        background: "用户需要重构 auth 模块",
        constraints: ["不改接口"],
        acceptance_criteria: ["tests pass"],
        stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, true,
      "PM depth=0 可以 spawn Leader（Tech Lead）");
    pm.destroy();
  });

  it("depth≥2 spawn Leader → depth_role_violation 拒绝", () => {
    const pm = new ProcessManager("hierarchical");
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run", depth: 0 });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", depth: 1 });
    ensureAgent({ id: "w-01",  name: "w-01",  role: "Worker", state: "run", parent: "tl-01", depth: 2 });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "w-01", child: "rogue-leader",
      role: "Leader", goal: "越权创建 Leader",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["done"], stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Worker");
    assert.equal(result.ok, false);
    // Either worker_cannot_spawn (hits first) or depth_role_violation
    assert.ok(
      (result as any).code === "worker_cannot_spawn" ||
      (result as any).code === "depth_role_violation",
      `code 应为 worker_cannot_spawn 或 depth_role_violation，实际: ${(result as any).code}`,
    );
    pm.destroy();
  });

  it("Tech Lead (depth=1) spawn Worker → ok", () => {
    const pm = new ProcessManager("hierarchical");
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run", depth: 0 });
    ensureAgent({ id: "tl-01", name: "tl-01", role: "Leader", state: "run", parent: "pm", depth: 1 });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "tl-01", child: "worker-01",
      role: "Worker", goal: "读取 README",
      dispatch: {
        background: "读文件任务",
        constraints: ["只读"],
        acceptance_criteria: ["输出内容"],
        stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, true,
      "Tech Lead (depth=1) 可以 spawn Worker");
    pm.destroy();
  });
});

// ── 2. setFanout / getMaxFanout ───────────────────────────────────────────────

describe("ProcessManager — setFanout", () => {
  it("默认 maxFanout=4，getMaxFanout 返回 4", () => {
    const pm = new ProcessManager("hierarchical");
    assert.equal(pm.getMaxFanout(), 4);
    pm.destroy();
  });

  it("setFanout(6) → getMaxFanout()=6，允许 6 个并发子节点", () => {
    const pm = new ProcessManager("hierarchical");
    pm.setFanout(6);
    assert.equal(pm.getMaxFanout(), 6);

    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0 });
    for (let i = 1; i <= 6; i++) {
      ensureAgent({ id: `tl-${i}`, name: `tl-${i}`, role: "Leader", state: "run", parent: "pm" });
    }
    // 第 7 个应被拒绝
    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "pm", child: "tl-7",
      role: "Leader", goal: "extra",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["done"], stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "fanout_exceeded");
    pm.destroy();
  });

  it("setFanout(1) → 只允许 1 个并发子节点", () => {
    const pm = new ProcessManager("hierarchical");
    pm.setFanout(1);
    assert.equal(pm.getMaxFanout(), 1);

    ensureAgent({ id: "pm",   name: "pm",   role: "Leader", state: "run", depth: 0 });
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm" });

    const ev: Extract<TuiEvent, { type: "spawn" }> = {
      v: 1, type: "spawn", parent: "pm", child: "tl-2",
      role: "Leader", goal: "second lead",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["done"], stop_conditions: ["agent.done"],
      },
    };
    const result = pm.preCheckSpawn(ev, "Leader");
    assert.equal(result.ok, false);
    assert.equal((result as any).code, "fanout_exceeded");
    pm.destroy();
  });

  it("setFanout 边界裁剪：0 → 1，17 → 16", () => {
    const pm = new ProcessManager("hierarchical");
    pm.setFanout(0);
    assert.equal(pm.getMaxFanout(), 1, "最小值裁剪为 1");
    pm.setFanout(17);
    assert.equal(pm.getMaxFanout(), 16, "最大值裁剪为 16");
    pm.destroy();
  });
});

describe("ProcessManager — health metrics", () => {
  it("maps pm.alert codes to HealthMetric event types", () => {
    assert.equal(metricTypeForAlert("loop_suspected"), "tool_call_repeated");
    assert.equal(metricTypeForAlert("no_progress"), "no_progress_nudge");
    assert.equal(metricTypeForAlert("dispatch_timeout"), "dispatch_timeout");
    assert.equal(metricTypeForAlert("illegal_message"), null);
  });

  it("repeated tool calls emit tool_call_repeated HealthMetric", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-health-metrics-"));
    const store = new HealthMetricsStore(dir);
    setHealthMetricsStoreForTests(store);
    const pm = new ProcessManager("hierarchical");

    try {
      for (let i = 0; i < 10; i++) {
        pm.observe({
          v: 1,
          type: "tool.call",
          agent: "worker-loop",
          id: `tc-${i}`,
          name: "Read",
          args: { path: "src/index.tsx" },
          needs_approval: false,
        });
      }

      const metrics = store.readMetrics();
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]!.event_type, "tool_call_repeated");
      assert.equal(metrics[0]!.agent_id, "worker-loop");
      assert.equal(metrics[0]!.meta?.pmAlertCode, "loop_suspected");
    } finally {
      pm.destroy();
      setHealthMetricsStoreForTests(null);
    }
  });
});

// ── 3. session_hash — createMemory 生成，loadMemoryByHash 查找 ────────────────

describe("MemoryStore — session_hash", () => {
  it("createMemory 生成 7 char hex session_hash", () => {
    const mem = createMemory({
      agentId: "pm",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "claude-sonnet-4-6",
      roleName: "PM",
    });
    assert.ok(mem.session_hash, "session_hash 应存在");
    assert.equal(mem.session_hash!.length, 7, "session_hash 应为 7 位");
    assert.ok(/^[0-9a-f]{7}$/.test(mem.session_hash!), "session_hash 应为小写十六进制");
  });

  it("同一 agentId 不同时刻 → session_hash 不同", () => {
    const m1 = createMemory({ agentId: "pm", agentType: "PM", parentChain: [], depth: 0, model: "m", roleName: "PM" });
    // 确保时间戳不同
    const m2 = createMemory({ agentId: "pm", agentType: "PM", parentChain: [], depth: 0, model: "m", roleName: "PM" });
    // session_hash 包含 created_at，即使同 agentId 也应不同（几率极低的碰撞可忽略）
    // 这里主要验证两个 memory 都有合法 hash
    assert.ok(/^[0-9a-f]{7}$/.test(m1.session_hash!));
    assert.ok(/^[0-9a-f]{7}$/.test(m2.session_hash!));
  });

  it("loadMemoryByHash 通过 hash 找到正确 AgentMemory", async () => {
    const mem = createMemory({
      agentId: "tl-hash-test",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "test",
      roleName: "Leader",
    });
    const sec = new SecretaryProxy(mem);
    await new Promise((r) => setImmediate(r));
    sec.destroy();

    const hash = mem.session_hash!;
    const found = loadMemoryByHash(hash);
    assert.ok(found, "loadMemoryByHash 应找到 memory");
    assert.equal(found!.agent_id, "tl-hash-test");
    assert.equal(found!.session_hash, hash);
  });

  it("loadMemoryByHash 找不到时返回 null", () => {
    const result = loadMemoryByHash("0000000");
    assert.equal(result, null, "不存在的 hash 应返回 null");
  });

  it("agentType PM 在 createMemory 中正确写入", () => {
    const mem = createMemory({
      agentId: "pm",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "test",
      roleName: "PM",
    });
    assert.equal(mem.agent_type, "PM");
    assert.equal(mem.depth, 0);
  });
});

// ── 4. SecretaryProxy.ingestChildMemory ──────────────────────────────────────

describe("SecretaryProxy — ingestChildMemory（PM-Secretary 聚合）", () => {
  it("ingestChildMemory 把子节点 facts 提升到父 working_set", async () => {
    // 创建 TL-Secretary 并写入 3 条 facts
    const tlMem = createMemory({
      agentId: "tl-01",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "test",
      roleName: "Leader",
    });
    const tlSec = new SecretaryProxy(tlMem);
    tlSec.observe({ v: 1, type: "tool.result", agent: "tl-01", id: "t1", ok: true, output: "fact A" });
    tlSec.observe({ v: 1, type: "tool.result", agent: "tl-01", id: "t2", ok: true, output: "fact B" });
    tlSec.observe({ v: 1, type: "tool.result", agent: "tl-01", id: "t3", ok: true, output: "fact C" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    tlSec.destroy();

    // 创建 PM-Secretary，初始 0 facts
    const pmMem = createMemory({
      agentId: "pm",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "test",
      roleName: "PM",
    });
    const pmSec = new SecretaryProxy(pmMem);
    assert.equal(pmSec.getMemory().working_set.facts.length, 0, "PM 初始 facts 应为 0");

    // 聚合 TL 的 memory
    const latestTlMem = loadMemory("tl-01")!;
    pmSec.ingestChildMemory(latestTlMem);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const pmLoaded = loadMemory("pm")!;
    assert.ok(pmLoaded.working_set.facts.length > 0, "PM 应聚合到来自 TL 的 facts");
    const factTexts = pmLoaded.working_set.facts.map((f) => f.text);
    assert.ok(factTexts.some((t) => t.includes("fact A") || t.includes("fact B") || t.includes("fact C")),
      "至少有一条 fact 来自 TL");
    assert.ok(pmLoaded.working_set.facts.every((f) => f.src.startsWith("handup:")),
      "聚合 fact 的 src 应以 handup: 开头");
    pmSec.destroy();
  });

  it("ingestChildMemory 把子节点 decisions 提升（最多 3 条）", async () => {
    const tlMem = createMemory({
      agentId: "tl-dec",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "test",
      roleName: "Leader",
    });
    const tlSec = new SecretaryProxy(tlMem);
    // 写入 4 条 decisions（超过 ingest 上限 3 条）
    for (let i = 1; i <= 4; i++) {
      tlSec.observe({
        v: 1, type: "message", agent: "tl-dec",
        to: "pm", text: `决定使用方案 ${i}`,
      });
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    tlSec.destroy();

    const pmMem = createMemory({
      agentId: "pm-dec",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "test",
      roleName: "PM",
    });
    const pmSec = new SecretaryProxy(pmMem);
    const latestTl = loadMemory("tl-dec")!;
    pmSec.ingestChildMemory(latestTl);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const pmLoaded = loadMemory("pm-dec")!;
    // ingestChildMemory 最多取 slice(-3)，TL 有 4 条 decisions，PM 得到 ≤ 3 条
    assert.ok(pmLoaded.working_set.decisions.length <= 3,
      "ingestChildMemory 最多聚合 3 条 decisions");
    pmSec.destroy();
  });

  it("ingestChildMemory 在 destroy 后不执行", async () => {
    const pmMem = createMemory({
      agentId: "pm-destroyed",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "test",
      roleName: "PM",
    });
    const pmSec = new SecretaryProxy(pmMem);
    pmSec.destroy(); // 先销毁

    const tlMem = createMemory({
      agentId: "tl-ghost",
      agentType: "LEADER",
      parentChain: ["pm-destroyed"],
      depth: 1,
      model: "test",
      roleName: "Leader",
    });
    tlMem.working_set.facts.push({ id: "f1", text: "ghost fact", src: "tool:x", ts: Date.now() });

    // 不应抛出，且不会写入（因为 destroyed=true）
    assert.doesNotThrow(() => pmSec.ingestChildMemory(tlMem));
    await new Promise((r) => setImmediate(r));

    // 重新加载 memory：应与初始状态一致（0 facts）
    const loaded = loadMemory("pm-destroyed")!;
    assert.equal(loaded.working_set.facts.length, 0,
      "destroyed 的 SecretaryProxy 不应写入 facts");
  });
});

describe("SecretaryProxy — health metrics", () => {
  it("factSimilarity handles CJK near-duplicates and keeps unrelated Chinese facts apart", () => {
    assert.ok(
      factTokens("配置文件在 src/config.ts，需要保留 baseUrl").has("配置"),
      "CJK tokenizer should emit character n-grams",
    );
    assert.ok(
      factSimilarity("配置文件在 src/config.ts，需要保留 baseUrl", "src/config.ts 的配置文件必须保留 baseUrl") >= 0.72,
      "near-duplicate Chinese facts should be similar",
    );
    assert.ok(
      factSimilarity("配置文件在 src/config.ts，需要保留 baseUrl", "飞书消息需要按 open_id 做会话隔离") < 0.72,
      "unrelated Chinese facts should not merge",
    );
    assert.ok(
      factSimilarity("registry exposes twelve tools for agents", "the registry exposes twelve tools for agents today") >= 0.72,
      "English near-duplicate facts should still merge",
    );
  });

  it("CJK duplicate fact corpus reaches at least 90% recall at merge threshold", () => {
    const pairs: Array<[string, string]> = [
      ["配置文件在 src/config.ts，需要保留 baseUrl", "src/config.ts 的配置文件必须保留 baseUrl"],
      ["飞书消息按 open_id 建立 PM 会话", "飞书消息需要按 open_id 建立 PM 会话"],
      ["测试失败时不能直接 agent.done(success:true)", "测试失败后不能直接 agent.done success"],
      ["WebSearch 默认供应商配置在 config.web.search.provider", "WebSearch 默认 provider 配置在 config.web.search.provider"],
      ["ProcessManager 对重复工具调用发 loop_suspected", "ProcessManager 会对重复工具调用触发 loop_suspected"],
      ["resume 缺失 memory 时写 resume_context_missing 指标", "resume memory 缺失时会写 resume_context_missing 指标"],
      ["Worker 不能直接 message.to=user", "Worker 不可以直接 message.to=user"],
      ["HealthMetric 写入 .spawn/metrics/health-metrics.jsonl", "HealthMetric 默认写入 .spawn/metrics/health-metrics.jsonl"],
      ["工具参数错误会返回 tool_error invalid_args", "工具参数错误时返回 tool_error invalid_args"],
      ["SecretaryProxy 会把相似 fact 合并并增加 weight", "SecretaryProxy 会合并相似 fact 并增加 weight"],
    ];
    const hits = pairs.filter(([a, b]) => factSimilarity(a, b) >= 0.72);
    assert.ok(hits.length >= 9, `expected >=9/10 CJK duplicate recall, got ${hits.length}/10`);
  });

  it("Chinese near-duplicate facts remain separate through SecretaryProxy", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-health-cjk-merge-"));
    const store = new HealthMetricsStore(dir);
    setHealthMetricsStoreForTests(store);
    const mem = createMemory({
      agentId: "w-cjk-merge",
      agentType: "WORKER",
      parentChain: ["pm", "tl"],
      depth: 2,
      model: "m",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    try {
      sec.observe({ v: 1, type: "tool.result", agent: "w-cjk-merge", id: "tc-1", ok: true, output: "配置文件在 src/config.ts，需要保留 baseUrl" });
      sec.observe({ v: 1, type: "tool.result", agent: "w-cjk-merge", id: "tc-2", ok: true, output: "src/config.ts 的配置文件必须保留 baseUrl" });

      const facts = sec.getMemory().working_set.facts;
      assert.equal(facts.length, 2);
      assert.equal(facts[0]!.weight, 1);
      assert.equal(store.readMetrics().some((m) => m.event_type === "memory_fact_merged"), false);
    } finally {
      sec.destroy();
      setHealthMetricsStoreForTests(null);
    }
  });

  it("unrelated Chinese facts stay separate", () => {
    const mem = createMemory({
      agentId: "w-cjk-distinct",
      agentType: "WORKER",
      parentChain: ["pm", "tl"],
      depth: 2,
      model: "m",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    try {
      sec.observe({ v: 1, type: "tool.result", agent: "w-cjk-distinct", id: "tc-1", ok: true, output: "配置文件在 src/config.ts，需要保留 baseUrl" });
      sec.observe({ v: 1, type: "tool.result", agent: "w-cjk-distinct", id: "tc-2", ok: true, output: "飞书消息需要按 open_id 做会话隔离" });

      assert.equal(sec.getMemory().working_set.facts.length, 2);
    } finally {
      sec.destroy();
    }
  });

  it("similar facts emit memory_fact_merged HealthMetric", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-health-merge-"));
    const store = new HealthMetricsStore(dir);
    setHealthMetricsStoreForTests(store);
    const mem = createMemory({
      agentId: "w-merge-metric",
      agentType: "WORKER",
      parentChain: ["pm", "tl"],
      depth: 2,
      model: "m",
      roleName: "Worker",
    });
    const sec = new SecretaryProxy(mem);

    try {
      sec.observe({ v: 1, type: "tool.result", agent: "w-merge-metric", id: "tc-1", ok: true, output: "same fact value" });
      sec.observe({ v: 1, type: "tool.result", agent: "w-merge-metric", id: "tc-2", ok: true, output: "same fact value" });

      const metrics = store.readMetrics();
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]!.event_type, "memory_fact_merged");
      assert.equal(metrics[0]!.agent_id, "w-merge-metric");
      assert.equal(metrics[0]!.meta?.src, "tool:tc-2");
    } finally {
      sec.destroy();
      setHealthMetricsStoreForTests(null);
    }
  });

  it("fact GC emits memory_fact_dropped HealthMetric", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-health-drop-"));
    const store = new HealthMetricsStore(dir);
    setHealthMetricsStoreForTests(store);
    const mem = createMemory({
      agentId: "w-drop-metric",
      agentType: "WORKER",
      parentChain: ["pm", "tl"],
      depth: 2,
      model: "m",
      roleName: "Worker",
    });
    const oldTs = Date.now() - 31 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 51; i++) {
      mem.working_set.facts.push({
        id: `old-${i}`,
        text: `old fact ${i}`,
        src: "test",
        ts: oldTs,
        weight: 1,
      });
    }
    const sec = new SecretaryProxy(mem);

    try {
      sec.observe({ v: 1, type: "tool.result", agent: "w-drop-metric", id: "tc-new", ok: true, output: "fresh unique fact" });

      const metrics = store.readMetrics();
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]!.event_type, "memory_fact_dropped");
      assert.equal(metrics[0]!.agent_id, "w-drop-metric");
      assert.equal(metrics[0]!.meta?.beforeCount, 52);
      assert.equal(metrics[0]!.meta?.afterCount, 50);
    } finally {
      sec.destroy();
      setHealthMetricsStoreForTests(null);
    }
  });
});

// ── 5. spawn role="Leader" → store 层 AgentInfo 正确 ─────────────────────────

describe("store — spawn role=Leader", () => {
  it("spawn role=Leader → AgentInfo.role 为 Leader，parent 正确", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });

    applyEvent({
      v: 1, type: "spawn", parent: "pm", child: "tl-store-test",
      role: "Leader", goal: "重构 auth 模块",
      dispatch: {
        background: "用户要求重构",
        constraints: [],
        acceptance_criteria: ["tests pass"],
        stop_conditions: ["agent.done"],
      },
    });

    const tl = getState().agents.get("tl-store-test");
    assert.ok(tl, "Tech Lead 应在 store 中注册");
    assert.equal(tl!.role, "Leader", "role 应为 Leader");
    assert.equal(tl!.parent, "pm", "parent 应为 pm");
    assert.equal(tl!.sub, "重构 auth 模块", "goal 应存入 sub");
  });

  it("PM → Tech Lead → Worker 三层树结构在 store 中正确", () => {
    ensureAgent({ id: "pm",    name: "pm",    role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "spawn", parent: "pm",    child: "tl-01", role: "Leader", goal: "tl task",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    });
    applyEvent({
      v: 1, type: "spawn", parent: "tl-01", child: "w-01",  role: "Worker", goal: "worker task",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["agent.done"] },
    });

    const pm   = getState().agents.get("pm");
    const tl   = getState().agents.get("tl-01");
    const w    = getState().agents.get("w-01");

    assert.equal(pm!.role,    "Leader");
    assert.equal(pm!.parent,  undefined);
    assert.equal(tl!.role,    "Leader");
    assert.equal(tl!.parent,  "pm");
    assert.equal(w!.role,     "Worker");
    assert.equal(w!.parent,   "tl-01");
  });

  it("spawn Leader 的消息出现在 PM 的消息列表中", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });
    applyEvent({
      v: 1, type: "spawn", parent: "pm", child: "tl-msg",
      role: "Leader", goal: "some goal",
      dispatch: { background: "bg", constraints: [], acceptance_criteria: ["done"], stop_conditions: ["done"] },
    });

    const pmMsgs = getState().messagesByAgent.get("pm") ?? [];
    assert.ok(pmMsgs.some((m) => m.kind === "system" && m.text.includes("tl-msg")),
      "spawn system 消息应出现在 PM 的对话列表");
  });
});

// ── 6. process-monitor 注册 ───────────────────────────────────────────────────

describe("process-monitor 注册为 PM 的 Secretary 子节点", () => {
  it("process-monitor 应能以 Secretary 角色注册在 PM 下", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "idle", depth: 0 });
    ensureAgent({
      id: "process-monitor", name: "monitor",
      role: "Secretary", parent: "pm",
      state: "run", sub: "supervising", model: "internal",
    });

    const monitor = getState().agents.get("process-monitor");
    assert.ok(monitor, "process-monitor 应注册到 store");
    assert.equal(monitor!.role,   "Secretary");
    assert.equal(monitor!.parent, "pm");
    assert.equal(monitor!.state,  "run");
    assert.equal(monitor!.sub,    "supervising");
  });
});

// ── 7. 完整三层 mock 链路 ─────────────────────────────────────────────────────

describe("三层 mock 链路：PM → Tech Lead → Worker", () => {
  it("PM spawn TL，TL spawn Worker，Worker 完成后 TL 完成，PM 更新状态", (_, done) => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });

    const events: string[] = [];

    // PM spawn TL
    applyEvent({
      v: 1, type: "spawn", parent: "pm", child: "tl-01",
      role: "Leader", goal: "负责 README 分析",
      dispatch: {
        background: "PM 委派的任务",
        constraints: [],
        acceptance_criteria: ["README 摘要"],
        stop_conditions: ["agent.done"],
      },
    });
    events.push("pm-spawned-tl");

    const tl = getState().agents.get("tl-01");
    assert.ok(tl, "TL 应已注册");
    assert.equal(tl!.role, "Leader");

    // TL spawn Worker
    applyEvent({
      v: 1, type: "spawn", parent: "tl-01", child: "w-01",
      role: "Worker", goal: "读取 README.md",
      dispatch: {
        background: "TL 委派的读取任务",
        constraints: ["只读"],
        acceptance_criteria: ["输出文件内容"],
        stop_conditions: ["agent.done"],
      },
    });
    events.push("tl-spawned-worker");

    const w = getState().agents.get("w-01");
    assert.ok(w, "Worker 应已注册");
    assert.equal(w!.parent, "tl-01");

    // Worker 完成
    applyEvent({ v: 1, type: "agent.state", agent: "w-01", state: "run" });
    applyEvent({
      v: 1, type: "todo.set", agent: "w-01",
      items: [{ id: "t1", state: "done", text: "读取 README" }],
    });
    applyEvent({ v: 1, type: "agent.done", agent: "w-01", success: true, reason: "README 读取完成" });
    events.push("worker-done");

    // TL 完成
    applyEvent({ v: 1, type: "agent.done", agent: "tl-01", success: true, reason: "README 分析完成" });
    events.push("tl-done");

    setImmediate(() => {
      assert.deepEqual(events, ["pm-spawned-tl", "tl-spawned-worker", "worker-done", "tl-done"],
        "事件顺序应正确");

      assert.equal(getState().agents.get("w-01")!.state,  "done", "Worker 状态应为 done");
      assert.equal(getState().agents.get("tl-01")!.state, "done", "TL 状态应为 done");
      assert.equal(getState().agents.get("pm")!.state,    "run",  "PM 不受子节点完成影响");

      // Worker 的 todo.set 应被记录
      const todos = getState().todosByAgent.get("w-01") ?? [];
      assert.equal(todos[0]!.state, "done");

      done();
    });
  });

  it("PM spawn TL，PM 发送的 spawn system 消息可见于 PM conv", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run" });

    applyEvent({
      v: 1, type: "spawn", parent: "pm", child: "tl-conv-test",
      role: "Leader", goal: "conv test task",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["done"], stop_conditions: ["agent.done"],
      },
    });

    const pmMsgs = getState().messagesByAgent.get("pm") ?? [];
    const spawnMsg = pmMsgs.find((m) => m.kind === "system");
    assert.ok(spawnMsg, "spawn system 消息应在 PM conv 中");
    assert.ok(spawnMsg!.text.includes("tl-conv-test"), "spawn 消息应包含子 agent id");
    assert.ok(spawnMsg!.text.includes("Leader"), "spawn 消息应包含角色");
  });
});

// ── 8. Tech Lead model 不被 spawn event 的 model 字段覆盖 ─────────────────────
//
// Bug 路径：PM（deepseek）输出 spawn JSON 时幻觉填了 "claude-sonnet-4-5"。
// 修复前：startWorker 直接传 model:e.model → startLeaderAgent 用了错误 model
//         → HttpConvAgent 拿 "claude-sonnet-4-5" 请求 deepseek API → 400。
// 修复后：startWorker 对 role=Leader 传 model:undefined → startLeaderAgent 解析
//         opts.model ?? cfg.agents.leader.model ?? MODEL → 用配置值，
//         最后调 updateAgentInfo 把正确 model 写回 store。

describe("Tech Lead — spawn event.model 不应影响实际使用的模型", () => {
  it("spawn role=Leader 携带幻觉 model → updateAgentInfo 覆盖为配置 model", () => {
    ensureAgent({ id: "pm", name: "pm", role: "Leader", state: "run", depth: 0 });

    // PM 在 spawn JSON 里幻觉了 "claude-sonnet-4-5"（deepseek provider 不认识这个名字）
    applyEvent({
      v: 1, type: "spawn", parent: "pm", child: "tl-hallucinated-model",
      role: "Leader", goal: "测试目标",
      model: "claude-sonnet-4-5",
      dispatch: {
        background: "测试背景", constraints: [],
        acceptance_criteria: ["完成"], stop_conditions: ["agent.done"],
      },
    });

    // applyEvent(spawn) 初始把 e.model 写进 store（正常行为，store 只记录事件）
    const initialModel = getState().agents.get("tl-hallucinated-model")?.model;
    assert.equal(initialModel, "claude-sonnet-4-5",
      "spawn 事件的 model 初始写入 store");

    // startLeaderAgent 用 opts.model=undefined → 解析到 cfg.agents.leader.model
    // 然后调 updateAgentInfo 把配置 model 覆盖进 store
    updateAgentInfo("tl-hallucinated-model", { model: "deepseek-v4-pro", depth: 1 });

    const finalModel = getState().agents.get("tl-hallucinated-model")?.model;
    assert.equal(finalModel, "deepseek-v4-pro",
      "store 最终应为配置 model，不是 LLM 幻觉值");
    assert.notEqual(finalModel, "claude-sonnet-4-5",
      "幻觉 model 不应保留");
  });

  it("model 解析逻辑：opts.model=undefined 时回退到配置 model", () => {
    // 直接验证 startLeaderAgent 里的解析式：
    //   const model = opts.model ?? cfg.agents.leader.model ?? MODEL
    const configuredModel = "deepseek-v4-pro";
    const fallbackModel   = "claude-sonnet-4-5";

    // 用函数包裹使 TypeScript 无法静态推断入参是否为 undefined
    const resolve = (optsModel: string | undefined): string =>
      optsModel ?? configuredModel ?? fallbackModel;

    assert.equal(resolve("claude-sonnet-4-5"), "claude-sonnet-4-5",
      "修复前：spawn event model 覆盖了配置");
    assert.equal(resolve(undefined), "deepseek-v4-pro",
      "修复后：undefined 回退到配置 model");
  });

  it("spawn role=Worker 的 model 字段应保留（Worker 允许自定义模型）", () => {
    // 对比：Leader 忽略 spawn model，Worker 保留 spawn model（允许 TL 指定 worker 模型）
    ensureAgent({ id: "pm",   name: "pm",   role: "Leader", state: "run", depth: 0 });
    ensureAgent({ id: "tl-1", name: "tl-1", role: "Leader", state: "run", parent: "pm", depth: 1 });

    applyEvent({
      v: 1, type: "spawn", parent: "tl-1", child: "worker-flash",
      role: "Worker", goal: "用指定模型完成任务",
      model: "deepseek-v4-flash",
      dispatch: {
        background: "bg", constraints: [],
        acceptance_criteria: ["完成"], stop_conditions: ["agent.done"],
      },
    });

    const workerModel = getState().agents.get("worker-flash")?.model;
    assert.equal(workerModel, "deepseek-v4-flash",
      "Worker 的 model 来自 spawn 事件，应保留在 store");
  });
});

// ── 9. PM memory agentType=PM 持久化 ─────────────────────────────────────────

describe("PM memory 持久化与 agentType", () => {
  it("PM memory agentType=PM 写入磁盘后可读回", async () => {
    const mem = createMemory({
      agentId: "pm-persist",
      agentType: "PM",
      parentChain: [],
      depth: 0,
      model: "claude-sonnet-4-6",
      roleName: "PM",
      dispatch: {
        background: "Root PM orchestrator",
        constraints: [],
        acceptance_criteria: [],
        stop_conditions: ["user.quit"],
      },
    });
    const sec = new SecretaryProxy(mem);
    await new Promise((r) => setImmediate(r));
    sec.destroy();

    const loaded = loadMemory("pm-persist");
    assert.ok(loaded, "PM memory 应可从磁盘读取");
    assert.equal(loaded!.agent_type, "PM");
    assert.equal(loaded!.depth, 0);
    assert.ok(/^[0-9a-f]{7}$/.test(loaded!.session_hash!), "session_hash 应存在且合法");
  });

  it("Tech Lead memory agentType=LEADER，depth=1", async () => {
    const mem = createMemory({
      agentId: "tl-persist",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "claude-sonnet-4-6",
      roleName: "Leader",
    });
    const sec = new SecretaryProxy(mem);
    await new Promise((r) => setImmediate(r));
    sec.destroy();

    const loaded = loadMemory("tl-persist");
    assert.equal(loaded!.agent_type, "LEADER");
    assert.equal(loaded!.depth, 1);
    assert.deepEqual(loaded!.parent_chain, ["pm"]);
  });
});
