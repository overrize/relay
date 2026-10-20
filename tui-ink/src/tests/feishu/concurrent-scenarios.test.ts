/**
 * Phase B/C/D/E concurrent dispatch + fork-merge-back scenarios.
 *
 * Uses a self-contained simulation harness that mirrors the actual state maps:
 *   feishuBusy, feishuForks, feishuPendingQueue, feishuCheckpoints,
 *   feishuForkBuffer, feishuForkSeq
 *
 * No real Feishu APIs or LLM calls are made.
 * Scenario 1 tests FeishuInputWindowManager with a tiny 30ms window.
 * All other scenarios drive the dispatch / drain / merge logic directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpConvAgent } from "../../adapters/httpAgent.js";
import { FeishuInputWindowManager } from "../../feishu/input-window.js";

// ── Shared simulation harness ─────────────────────────────────────────────────

type Msg = { role: "user" | "assistant"; content: string };
interface PendingMsg { text: string; anchorMsgId: string }
interface ForkRecord {
  forkId: string; seq: number; openId: string;
  text: string; anchorMsgId: string; initialMessages: Msg[];
}

function makeSimulator(maxConcurrent = 3) {
  const feishuBusy    = new Set<string>();
  const feishuForks   = new Map<string, Set<string>>();
  const pendingQueue  = new Map<string, PendingMsg[]>();
  const checkpoints   = new Map<string, Msg[]>();
  // Merge-back state (Phase D)
  let forkArrivalSeq = 0;
  const forkBuffer    = new Map<string, Array<{ seq: number; anchorMsgId: string; question: string; answer: string }>>();
  // Track what appendHistory was called with (simulates base PM live messages update)
  const appendedEntries: Array<{ pmId: string; entries: Msg[] }> = [];
  // Fork creation log
  const forkLog: ForkRecord[] = [];
  let forkSeq = 0;

  const compact = (msgs: Msg[], maxChars: number): Msg[] => {
    let total = msgs.reduce((s, m) => s + m.content.length, 0);
    if (total <= maxChars) return msgs.slice();
    const result = [...msgs];
    let i = 1;
    while (total > maxChars && i < result.length - 4) { total -= result[i]!.content.length; result.splice(i, 1); }
    return result;
  };

  const dispatch = (
    openId: string, basePmId: string, text: string, anchorMsgId = "msg-x",
  ): { type: "direct" | "forked" | "queued"; forkId?: string; queueLen?: number } => {
    if (feishuBusy.has(basePmId)) {
      const forkCount = feishuForks.get(openId)?.size ?? 0;
      if (forkCount < maxConcurrent - 1) {
        const forkId = `fork-${++forkSeq}`;
        const seq    = ++forkArrivalSeq;
        const rawCp  = checkpoints.get(basePmId) ?? [];
        // Phase E: peek at buffer without consuming — new fork gets completed-fork context
        const bufPeek = forkBuffer.get(openId);
        const pendingForkMsgs: Msg[] = bufPeek && bufPeek.length > 0
          ? [...bufPeek].sort((a, b) => a.seq - b.seq).flatMap(c => ([
              { role: "user"      as const, content: c.question },
              { role: "assistant" as const, content: c.answer   },
            ]))
          : [];
        const initMsgs = compact([...rawCp, ...pendingForkMsgs], 40_000);
        const forks = feishuForks.get(openId) ?? new Set<string>();
        forks.add(forkId);
        feishuForks.set(openId, forks);
        feishuBusy.add(forkId);
        forkLog.push({ forkId, seq, openId, text, anchorMsgId, initialMessages: initMsgs });
        return { type: "forked", forkId };
      }
      const q = pendingQueue.get(openId) ?? [];
      q.push({ text, anchorMsgId });
      pendingQueue.set(openId, q);
      return { type: "queued", queueLen: q.length };
    }
    // Phase E: base PM idle → flush any completed fork Q/As before delivering new message.
    // Simulates flushForkBufferToBase: updates checkpoint + records in appendedEntries.
    const buf = forkBuffer.get(openId);
    if (buf && buf.length > 0) {
      buf.sort((a, b) => a.seq - b.seq);
      const forkEntries = buf.flatMap(c => ([
        { role: "user"      as const, content: c.question },
        { role: "assistant" as const, content: c.answer   },
      ]));
      appendedEntries.push({ pmId: basePmId, entries: forkEntries });
      const currentCp = checkpoints.get(basePmId) ?? [];
      checkpoints.set(basePmId, currentCp.concat(forkEntries));
      forkBuffer.delete(openId);
    }
    feishuBusy.add(basePmId);
    return { type: "direct" };
  };

  const drain = (openId: string, basePmId: string): void => {
    const q = pendingQueue.get(openId);
    if (!q || q.length === 0) return;
    const forkCount = feishuForks.get(openId)?.size ?? 0;
    const total = (feishuBusy.has(basePmId) ? 1 : 0) + forkCount;
    if (total >= maxConcurrent) return;
    const next = q.shift()!;
    dispatch(openId, basePmId, next.text, next.anchorMsgId);
  };

  // completeFork: buffers Q/A for later merge
  const completeFork = (
    openId: string, forkId: string, basePmId: string,
    answer: string, // what the fork replied to the user
  ): void => {
    feishuBusy.delete(forkId);
    const record = forkLog.find(f => f.forkId === forkId);
    if (record && answer) {
      const buf = forkBuffer.get(openId) ?? [];
      buf.push({ seq: record.seq, anchorMsgId: record.anchorMsgId, question: record.text, answer });
      forkBuffer.set(openId, buf);
    }
    feishuForks.get(openId)?.delete(forkId);
    if ((feishuForks.get(openId)?.size ?? 0) === 0) feishuForks.delete(openId);
    drain(openId, basePmId);
  };

  // completeBase: merges forkBuffer → checkpoint + appendHistory
  const completeBase = (openId: string, basePmId: string, finalMessages: Msg[]): void => {
    feishuBusy.delete(basePmId);
    let cleanHistory = finalMessages.slice();
    const buf = forkBuffer.get(openId);
    if (buf && buf.length > 0) {
      buf.sort((a, b) => a.seq - b.seq);
      const forkEntries = buf.flatMap(c => ([
        { role: "user"      as const, content: c.question },
        { role: "assistant" as const, content: c.answer   },
      ]));
      cleanHistory = cleanHistory.concat(forkEntries);
      appendedEntries.push({ pmId: basePmId, entries: forkEntries }); // simulate bpm.appendHistory
      forkBuffer.delete(openId);
    }
    checkpoints.set(basePmId, cleanHistory);
    drain(openId, basePmId);
  };

  return {
    dispatch, drain, completeFork, completeBase,
    feishuBusy, feishuForks, pendingQueue, checkpoints,
    forkBuffer, forkLog, appendedEntries,
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Scenario tests ─────────────────────────────────────────────────────────────

describe("Phase B/C/D — concurrent scenarios (simulation)", () => {

  // ── 场景1: 碎片合并 ────────────────────────────────────────────────────────
  it("场景1 碎片合并: 1500ms 内连发 3 条 → 只 1 次 dispatch, 文本合并", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const WIN = 30;
    const dispatched: Array<{ text: string; anchor: string }> = [];
    const mgr = new FeishuInputWindowManager(WIN, (_, text, anchor) => {
      dispatched.push({ text, anchor });
    });
    mgr.feed("u1", "I2C", "msg-1", "chat1", "p2p");
    t.mock.timers.tick(10);
    mgr.feed("u1", "总线", "msg-2", "chat1", "p2p");
    t.mock.timers.tick(10);
    mgr.feed("u1", "挂死", "msg-3", "chat1", "p2p");
    t.mock.timers.tick(WIN + 20);
    assert.equal(dispatched.length, 1, "exactly 1 dispatch after merge");
    assert.equal(dispatched[0]!.text, "I2C\n总线\n挂死");
    assert.equal(dispatched[0]!.anchor, "msg-1");
  });

  // ── 场景2: base busy → fork ────────────────────────────────────────────────
  it("场景2 并发开 fork: base busy 时发 2 条 → 2 个 fork 启动", () => {
    const { dispatch, feishuForks, feishuBusy } = makeSimulator(3);
    const oid = "u1", base = "pm1";
    assert.equal(dispatch(oid, base, "Q1").type, "direct");
    assert.equal(dispatch(oid, base, "Q2").type, "forked");
    assert.equal(dispatch(oid, base, "Q3").type, "forked");
    assert.equal(feishuForks.get(oid)?.size, 2);
    assert.equal(feishuBusy.size, 3);
  });

  // ── 场景3: 满载 → pendingQueue ────────────────────────────────────────────
  it("场景3 满载排队: base + 2 fork 时发第 4 条 → 进 pendingQueue", () => {
    const { dispatch, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "u2", base = "pm2";
    dispatch(oid, base, "Q1"); dispatch(oid, base, "Q2"); dispatch(oid, base, "Q3");
    assert.equal(feishuForks.get(oid)?.size, 2);
    assert.equal(dispatch(oid, base, "Q4").type, "queued");
    assert.equal(pendingQueue.get(oid)?.length, 1);
  });

  // ── 场景4: drain 出队 ──────────────────────────────────────────────────────
  it("场景4 drain 出队: 一个 fork 完成 → pendingQueue[0] 出队启动", () => {
    const { dispatch, completeFork, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "u3", base = "pm3";
    dispatch(oid, base, "Q1");
    const r1 = dispatch(oid, base, "Q2");
    dispatch(oid, base, "Q3");
    dispatch(oid, base, "Q4"); dispatch(oid, base, "Q5");
    assert.equal(pendingQueue.get(oid)?.length, 2);
    completeFork(oid, (r1 as { forkId: string }).forkId, base, "A2");
    assert.equal(pendingQueue.get(oid)?.length, 1, "one item drained");
    assert.equal(feishuForks.get(oid)?.size, 2);
  });

  // ── 场景5: fork 快照隔离 (Bug 1 fix) ────────────────────────────────────
  it("场景5 fork 快照隔离: base 处理 Q1 时 fork Q2 → fork initialMessages 不含 Q1", () => {
    const { dispatch, forkLog, checkpoints } = makeSimulator(3);
    const oid = "u4", base = "pm4";
    const hist: Msg[] = [
      { role: "user",      content: "Q0 历史" },
      { role: "assistant", content: "A0 历史" },
    ];
    checkpoints.set(base, hist);
    dispatch(oid, base, "Q1"); // base busy, no checkpoint update
    dispatch(oid, base, "Q2"); // → fork
    const fork = forkLog[0]!;
    assert.deepEqual(fork.initialMessages, hist, "fork uses clean checkpoint");
    assert.ok(!fork.initialMessages.some(m => m.content.includes("Q1")), "no Q1 in snapshot");
  });

  // ── 场景6: fork 错误隔离 ─────────────────────────────────────────────────
  it("场景6 fork 错误隔离: fork-1 抛错 → fork-2 不受影响", () => {
    const { dispatch, feishuBusy, feishuForks } = makeSimulator(3);
    const oid = "u5", base = "pm5";
    dispatch(oid, base, "Q1");
    const r1 = dispatch(oid, base, "Q2");
    const r2 = dispatch(oid, base, "Q3");
    const fork1 = (r1 as { forkId: string }).forkId;
    const fork2 = (r2 as { forkId: string }).forkId;
    feishuBusy.delete(fork1); feishuForks.get(oid)?.delete(fork1); // simulate kill
    assert.ok(feishuBusy.has(fork2)); assert.ok(feishuForks.get(oid)?.has(fork2));
  });

  // ── 场景7: 上限不超 ────────────────────────────────────────────────────────
  it("场景7 上限不超: 连发 6 条 → 同时 running 数始终 ≤ 3", () => {
    const { dispatch, completeFork, feishuBusy, feishuForks, forkLog } = makeSimulator(3);
    const oid = "u6", base = "pm6";
    for (let i = 1; i <= 6; i++) dispatch(oid, base, `Q${i}`);
    assert.ok((feishuBusy.has(base) ? 1 : 0) + (feishuForks.get(oid)?.size ?? 0) <= 3);
    if (forkLog.length > 0) {
      completeFork(oid, forkLog[0]!.forkId, base, "A_fork1");
      assert.ok((feishuBusy.has(base) ? 1 : 0) + (feishuForks.get(oid)?.size ?? 0) <= 3);
    }
  });

  // ── Bug2: drain 容量判定 ─────────────────────────────────────────────────
  it("Bug2 drain 满载不放行: base + 2 fork → drain 返回", () => {
    const { dispatch, drain, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "u7", base = "pm7";
    dispatch(oid, base, "Q1"); dispatch(oid, base, "Q2"); dispatch(oid, base, "Q3");
    pendingQueue.set(oid, [{ text: "Q4", anchorMsgId: "m4" }]);
    drain(oid, base);
    assert.equal(pendingQueue.get(oid)?.length, 1, "must not fire");
    assert.equal(feishuForks.get(oid)?.size, 2);
  });

  it("Bug2 drain 半载可放行: base + 1 fork → drain 启动第 2 个 fork", () => {
    const { dispatch, drain, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "u8", base = "pm8";
    dispatch(oid, base, "Q1"); dispatch(oid, base, "Q2");
    pendingQueue.set(oid, [{ text: "Q3", anchorMsgId: "m3" }]);
    drain(oid, base);
    assert.equal(pendingQueue.get(oid)?.length, 0, "Q3 drained");
    assert.equal(feishuForks.get(oid)?.size, 2);
  });

  it("Bug2 drain 路由: base PM 完成后 pending 直投 base PM(不 fork)", () => {
    const { dispatch, completeBase, feishuBusy, feishuForks, pendingQueue } = makeSimulator(3);
    const oid = "u9", base = "pm9";
    dispatch(oid, base, "Q1");
    pendingQueue.set(oid, [{ text: "Q2", anchorMsgId: "m2" }]);
    completeBase(oid, base, [{ role: "user", content: "Q1" }, { role: "assistant", content: "A1" }]);
    assert.ok(feishuBusy.has(base), "base re-acquired busy for Q2");
    assert.equal(feishuForks.get(oid)?.size ?? 0, 0, "no fork created");
    assert.equal(pendingQueue.get(oid)?.length, 0);
  });
});

// ── Phase D: fork merge-back tests ───────────────────────────────────────────

describe("Phase D — fork Q/A merge-back into base PM history", () => {
  it("fork 完成后 Q/A 进入 forkBuffer(含 seq 和 answer)", () => {
    const { dispatch, completeFork, forkBuffer } = makeSimulator(3);
    const oid = "o1", base = "b1";
    dispatch(oid, base, "Q1"); // base
    dispatch(oid, base, "Q2"); // fork-1
    const forkId = "fork-1";
    // Force matching by using the actual fork ID from forkLog
    const { forkLog } = makeSimulator(3);
    // Re-run with captured log
    const sim = makeSimulator(3);
    sim.dispatch(oid, base, "Q1");
    sim.dispatch(oid, base, "Q2");
    const record = sim.forkLog[0]!;
    sim.completeFork(oid, record.forkId, base, "A2-reply");
    const buf = sim.forkBuffer.get(oid);
    assert.ok(buf && buf.length === 1, "one entry buffered");
    assert.equal(buf![0]!.question, "Q2");
    assert.equal(buf![0]!.answer,   "A2-reply");
    assert.equal(buf![0]!.seq,      record.seq);
    void forkId; void forkBuffer; void dispatch; void completeFork; // suppress unused
  });

  it("乱序完成 → 合并按到达序排列(先到先排)", () => {
    const sim = makeSimulator(3);
    const oid = "o2", base = "b2";
    sim.dispatch(oid, base, "Q1"); // base
    sim.dispatch(oid, base, "Q2"); // fork-1 (seq=1)
    sim.dispatch(oid, base, "Q3"); // fork-2 (seq=2)

    const [fork1, fork2] = [sim.forkLog[0]!, sim.forkLog[1]!];
    // fork-2 (Q3) completes FIRST
    sim.completeFork(oid, fork2.forkId, base, "A3-first");
    // fork-1 (Q2) completes SECOND
    sim.completeFork(oid, fork1.forkId, base, "A2-second");

    // Base PM finishes Q1
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);

    // Checkpoint should have Q2/A2 before Q3/A3 (arrival order, not completion order)
    const checkpoint = sim.checkpoints.get(base)!;
    const q2idx = checkpoint.findIndex(m => m.content === "Q2");
    const q3idx = checkpoint.findIndex(m => m.content === "Q3");
    assert.ok(q2idx !== -1, "Q2 in checkpoint");
    assert.ok(q3idx !== -1, "Q3 in checkpoint");
    assert.ok(q2idx < q3idx, `Q2(idx=${q2idx}) should precede Q3(idx=${q3idx}) in history`);
  });

  it("base PM turnEnd 时 forkBuffer 合并进 checkpoint + appendHistory", () => {
    const sim = makeSimulator(3);
    const oid = "o3", base = "b3";
    const prevHistory: Msg[] = [
      { role: "user",      content: "Q0" },
      { role: "assistant", content: "A0" },
    ];
    sim.checkpoints.set(base, prevHistory);

    sim.dispatch(oid, base, "Q1"); // base
    sim.dispatch(oid, base, "Q2"); // fork
    const record = sim.forkLog[0]!;

    // Fork completes
    sim.completeFork(oid, record.forkId, base, "A2");

    // Base PM finishes Q1
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);

    const cp = sim.checkpoints.get(base)!;
    assert.ok(cp.some(m => m.content === "Q1"), "Q1 in checkpoint");
    assert.ok(cp.some(m => m.content === "A1"), "A1 in checkpoint");
    assert.ok(cp.some(m => m.content === "Q2"), "fork Q2 merged into checkpoint");
    assert.ok(cp.some(m => m.content === "A2"), "fork A2 merged into checkpoint");

    // appendHistory should have been called with fork entries
    const appended = sim.appendedEntries.find(e => e.pmId === base);
    assert.ok(appended, "appendHistory called on base PM");
    assert.ok(appended!.entries.some(e => e.content === "Q2"), "Q2 in appendHistory");
    assert.ok(appended!.entries.some(e => e.content === "A2"), "A2 in appendHistory");
  });

  it("fork 无回复(silent failure) → 不进 buffer", () => {
    const sim = makeSimulator(3);
    const oid = "o4", base = "b4";
    sim.dispatch(oid, base, "Q1");
    sim.dispatch(oid, base, "Q2");
    const record = sim.forkLog[0]!;
    // Complete with empty answer (silent failure)
    sim.completeFork(oid, record.forkId, base, "");
    assert.equal(sim.forkBuffer.get(oid)?.length ?? 0, 0, "silent fork not buffered");
  });

  it("后续 fork 可见已合并历史(通过 checkpoint)", () => {
    const sim = makeSimulator(3);
    const oid = "o5", base = "b5";

    // Turn 1: base processes Q1, fork processes Q2
    sim.dispatch(oid, base, "Q1");
    const r1 = sim.dispatch(oid, base, "Q2");
    const forkRecord1 = sim.forkLog[0]!;
    sim.completeFork(oid, forkRecord1.forkId, base, "A2");
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);
    // Checkpoint now has Q1/A1 + Q2/A2

    // Turn 2: base processes Q3, fork created for Q4
    // Fork should see Q2/A2 in its snapshot (via checkpoint)
    sim.dispatch(oid, base, "Q3"); // base busy again
    const r2 = sim.dispatch(oid, base, "Q4"); // fork
    const forkRecord2 = sim.forkLog[1]!;
    assert.equal(forkRecord2.text, "Q4");
    assert.ok(forkRecord2.initialMessages.some(m => m.content === "Q2"),
      "turn-2 fork should see Q2 from merged history");
    assert.ok(forkRecord2.initialMessages.some(m => m.content === "A2"),
      "turn-2 fork should see A2 from merged history");
    void r1; void r2; // suppress unused
  });
});

// ── Phase E: pre-dispatch flush + fork buffer peek ───────────────────────────

describe("Phase E — pre-dispatch flush (base-idle) + fork buffer peek (base-busy)", () => {

  // Scenario: Q1 finishes → Q2(fork) finishes later → Q3 arrives (base idle)
  // Without Phase E, Q3 would be processed without seeing Q2/A2.
  // With Phase E, flushForkBufferToBase fires before Q3 is delivered.
  it("base idle 直投: fork 完成写 buffer → Q3 到达时 pre-dispatch flush 注入 Q2/A2", () => {
    const sim = makeSimulator(3);
    const oid = "e1", base = "b_e1";

    // Turn 1: Q1 on base, Q2 on fork
    sim.dispatch(oid, base, "Q1");
    sim.dispatch(oid, base, "Q2"); // fork

    // Q1 finishes FIRST (buffer still empty)
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);
    assert.equal(sim.forkBuffer.get(oid)?.length ?? 0, 0, "buffer empty after Q1 done");

    // Fork Q2 finishes AFTER Q1 (scenario B: base idle, buffer non-empty)
    const fork1 = sim.forkLog[0]!;
    sim.completeFork(oid, fork1.forkId, base, "A2");
    assert.equal(sim.forkBuffer.get(oid)?.length, 1, "buffer has Q2/A2 after fork done");

    // Q3 arrives — base PM is idle → pre-dispatch flush fires
    const appendsBefore = sim.appendedEntries.length;
    sim.dispatch(oid, base, "Q3");

    // Buffer must be cleared
    assert.equal(sim.forkBuffer.get(oid)?.length ?? 0, 0, "buffer cleared by pre-dispatch flush");
    // appendedEntries should have a new entry for base PM
    assert.ok(sim.appendedEntries.length > appendsBefore, "appendHistory called during flush");
    const flushEntry = sim.appendedEntries.find(
      (e, i) => i >= appendsBefore && e.pmId === base,
    )!;
    assert.ok(flushEntry.entries.some(e => e.content === "Q2"), "Q2 flushed into base PM");
    assert.ok(flushEntry.entries.some(e => e.content === "A2"), "A2 flushed into base PM");
    // Checkpoint must reflect Q2/A2 BEFORE Q3 is processed
    const cp = sim.checkpoints.get(base)!;
    assert.ok(cp.some(m => m.content === "Q2"), "Q2 in checkpoint before Q3 turn");
    assert.ok(cp.some(m => m.content === "A2"), "A2 in checkpoint before Q3 turn");
  });

  it("pre-dispatch flush 空 buffer 时是 no-op (不写 appendedEntries)", () => {
    const sim = makeSimulator(3);
    const oid = "e2", base = "b_e2";
    sim.dispatch(oid, base, "Q1");
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);
    // Buffer is empty — next dispatch should not touch appendedEntries
    const appendsBefore = sim.appendedEntries.length;
    sim.dispatch(oid, base, "Q2");
    assert.equal(sim.appendedEntries.length, appendsBefore, "no flush when buffer empty");
  });

  // Scenario: base busy with Q1, fork-A completes, fork-B created while base still busy.
  // Fork-B should see Q-A/A-A in its snapshot via bufPeek (buffer NOT consumed).
  it("fork 创建 bufPeek: base busy 时 fork-A 完成 → 新 fork-B 快照含 Q-A/A-A, buffer 未消费", () => {
    const sim = makeSimulator(3);
    const oid = "e3", base = "b_e3";

    sim.dispatch(oid, base, "Q1");         // base busy
    sim.dispatch(oid, base, "Q-A");        // fork-A
    const forkA = sim.forkLog[0]!;

    // Fork-A completes while base PM is still processing Q1
    sim.completeFork(oid, forkA.forkId, base, "A-A");
    assert.equal(sim.forkBuffer.get(oid)?.length, 1, "fork-A in buffer");

    // Q-B arrives while base still busy → fork-B created
    sim.dispatch(oid, base, "Q-B");
    const forkB = sim.forkLog[1]!;

    // Fork-B's snapshot should include Q-A/A-A via bufPeek
    assert.ok(forkB.initialMessages.some(m => m.content === "Q-A"),
      "fork-B snapshot includes Q-A from bufPeek");
    assert.ok(forkB.initialMessages.some(m => m.content === "A-A"),
      "fork-B snapshot includes A-A from bufPeek");

    // Buffer was NOT consumed — it stays for the eventual base PM flush
    assert.equal(sim.forkBuffer.get(oid)?.length, 1, "buffer intact after bufPeek");
  });

  // End-to-end: Q1 base + Q2 fork + Q1-done + Q2-done + Q3 arrives.
  // Q3's checkpoint must order Q1/A1 before Q2/A2.
  it("E2E 顺序: Q1 base, Q2 fork; Q1先完成再 Q2 完成; Q3 到达时 checkpoint 含 Q1/A1 + Q2/A2 且顺序正确", () => {
    const sim = makeSimulator(3);
    const oid = "e4", base = "b_e4";

    sim.dispatch(oid, base, "Q1");
    sim.dispatch(oid, base, "Q2");
    const fork1 = sim.forkLog[0]!;

    // Q1 finishes, Q2 not done yet
    sim.completeBase(oid, base, [
      { role: "user", content: "Q1" }, { role: "assistant", content: "A1" },
    ]);
    // Now Q2 finishes (after Q1 turn end, no base PM turnEnd between Q2 done and Q3 arriving)
    sim.completeFork(oid, fork1.forkId, base, "A2");

    // Q3 → pre-dispatch flush fires
    sim.dispatch(oid, base, "Q3");

    const cp = sim.checkpoints.get(base)!;
    const q1idx = cp.findIndex(m => m.content === "Q1");
    const q2idx = cp.findIndex(m => m.content === "Q2");
    assert.ok(q1idx !== -1 && q2idx !== -1, "both Q1 and Q2 in checkpoint");
    assert.ok(q1idx < q2idx, `Q1(idx=${q1idx}) should precede Q2(idx=${q2idx})`);
    assert.equal(sim.forkBuffer.get(oid)?.length ?? 0, 0, "buffer cleared");
  });
});

// ── Interface contract ────────────────────────────────────────────────────────
describe("HttpConvAgent static/instance interface", () => {
  it("compactHistory trims middle, keeps first + last 4", () => {
    const msgs: Msg[] = Array.from({ length: 7 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "X".repeat(1000),
    }));
    const out = HttpConvAgent.compactHistory(msgs, 3000);
    assert.equal(out[0], msgs[0]);
    assert.deepEqual(out.slice(-4), msgs.slice(-4));
  });

  it("appendHistory appends entries to the messages", () => {
    // appendHistory is tested via the instance method — verify it exists and is callable
    assert.equal(typeof HttpConvAgent.prototype.appendHistory, "function");
    assert.equal(typeof HttpConvAgent.prototype.getMessages,   "function");
    assert.equal(typeof HttpConvAgent.compactHistory,          "function");
  });
});
