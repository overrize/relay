// SecretaryProxy — TypeScript 实现的内存管理员
// 订阅 agent event stream，自动维护 .spawn/memory/<agent_id>.json
// 不是 LLM，不消耗 token，只做确定性的记录工作

import {signalWorklog} from '../worklog/RelayBridge.js';
import { EventEmitter } from "node:events";
import type { TuiEvent } from "../protocol.js";
import type { AgentMemory, MemoryFact, MemoryDecision } from "./types.js";
import { saveMemory, appendMessage, appendReminder, startSession, topFactsByWeight, archiveFacts } from "./MemoryStore.js";
import { globalBus } from "../bus/Bus.js";
import { recordHealthMetric } from "../runtime/HealthMetrics.js";

// M1-4: fallback-only heuristic. Requires an actual decision VERB (not a topic
// word like 方案/should/will) and excludes questions, so "这个方案你看过了吗？"
// is no longer captured. Primary path is the explicit decision.record event.
const DECISION_VERB = /决定|采用|选择|采取|确定|敲定|拍板|decided|chose|chosen|adopt|go with/i;
const QUESTION_HINT = /[?？]|吗\s*[?？]?\s*$|呢\s*[?？]?\s*$/;
function looksLikeDecision(text: string): boolean {
  return DECISION_VERB.test(text) && !QUESTION_HINT.test(text);
}
const TIME_KEYWORDS = /下午|上午|晚上|早上|明天|后天|今天|[0-9]+[:：][0-9]+|[0-9]+\s*点|pm\b|am\b/i;

export class SecretaryProxy extends EventEmitter {
  private memory: AgentMemory;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private factSeq: number;
  private decisionSeq: number;
  private destroyed = false;
  // M1-8: tool.calls issued but not yet resolved — persisted to tombstone for resume.
  private _inflightTools = new Map<string, { id: string; name: string; args?: unknown; needs_approval?: boolean }>();
  // Accept btw messages addressed to "<id>-secretary" as well as "<id>"
  private readonly secretaryAlias: string;
  // Bus log offset: the working_set reflects all events published up to this point.
  // On resume: replay log from this offset onwards to recover events not yet in working_set.
  private _logCursor: number = 0;

  constructor(memory: AgentMemory, opts: { startNewSession?: boolean } = {}) {
    super();signalWorklog();
    this.memory = memory;
    // Resume: init seqs from existing data to avoid ID collisions
    this.factSeq = Math.max(0, ...memory.working_set.facts.map((f) => Number(f.id.match(/^f(\d+)$/)?.[1] ?? 0)), Date.now());
    this.decisionSeq = Math.max(0, ...memory.working_set.decisions.map((d) => Number(d.id.match(/^d(\d+)$/)?.[1] ?? 0)), Date.now());
    this.secretaryAlias = `${memory.agent_id}-secretary`;
    // Cursor: if the tombstone carries a cursor from the SAME process epoch, honour it
    // (intra-process recovery). Otherwise discard it — the ring was reset at restart.
    if (
      memory.tombstone.log_cursor !== undefined &&
      memory.tombstone.log_cursor_epoch === globalBus.getEpoch()
    ) {
      this._logCursor = memory.tombstone.log_cursor;
    } else {
      // Cross-restart or fresh agent: treat current head as baseline.
      this._logCursor = globalBus.getHeadOffset();
    }
    // Persist initial state + register new session entry
    saveMemory(memory.agent_id, memory);
    if (opts.startNewSession !== false) {
      startSession(memory.agent_id, memory.session_hash ?? "unknown");
    }

    // 60s periodic snapshot —防止崩溃时丢失进度
    this.snapshotTimer = setInterval(() => {
      if (!this.destroyed) this.flushSync();
    }, 60_000);
    this.snapshotTimer.unref();
  }

  get agentId(): string { return this.memory.agent_id; }

  /** 观察 agent 发出的 TuiEvent，按规则更新 memory */
  observe(ev: TuiEvent): void {
    if (this.destroyed) return;
    signalWorklog();
    const id = this.memory.agent_id;

    switch (ev.type) {
      case "tool.call":
        // M1-8: track in-flight tool.calls so an interruption's "现场" survives.
        if (ev.agent === id) {
          this._inflightTools.set(ev.id, { id: ev.id, name: ev.name, args: ev.args, needs_approval: ev.needs_approval });
          this.saveAsync();
        }
        break;

      case "tool.result":
        if (ev.agent === id) {
          this._inflightTools.delete(ev.id); // completed → no longer in flight
          this.saveAsync();
          if (ev.ok) {
            this.addFact({
              id: `f${++this.factSeq}`,
              text: ev.output.slice(0, 200),
              src: `tool:${ev.id}`,
              ts: Date.now(),
            });
          }
        }
        break;

      case "decision.record":
        if (ev.agent === id) {
          this.addDecision({
            id: `d${++this.decisionSeq}`,
            text: ev.decision.slice(0, 300),
            rationale: (ev.reason ?? "").slice(0, 300),
            ts: Date.now(),
          });
        }
        break;

      case "message":
        if (ev.agent === id) {
          // Fallback only — the primary path is the explicit decision.record event.
          if (looksLikeDecision(ev.text)) {
            this.addDecision({
              id: `d${++this.decisionSeq}`,
              text: ev.text.slice(0, 300),
              rationale: "",
              ts: Date.now(),
            });
          }
        }
        // btw 消息：leader 可以发到 "<id>" 或 "<id>-secretary"
        if ((ev.to === id || ev.to === this.secretaryAlias) && ev.text.startsWith("btw:")) {
          this.handleBtw(ev.text.slice(4).trim());
        }
        break;

      case "todo.set":
        if (ev.agent === id) {
          // 记录完成的 todo 项到 decisions
          for (const item of ev.items) {
            if (item.state === "done") {
              this.addDecision({
                id: `d${++this.decisionSeq}`,
                text: `已完成: ${item.text}`,
                rationale: "todo done",
                ts: Date.now(),
              });
            }
          }
          // 保存最后 todo 状态，供 resume 注入
          this.memory.tombstone.last_todo = JSON.stringify(ev.items);
          this.saveAsync();
        }
        break;

      case "unit.handup":
        if (ev.agent === id) {
          // 把 Worker 上报的 facts_to_promote 提升到本 agent 的 working_set
          const promoted = (ev as any).facts_to_promote as string[] | undefined;
          for (const text of promoted ?? []) {
            this.addFact({
              id: `f${++this.factSeq}`,
              text,
              src: `handup:${ev.agent}`,
              ts: Date.now(),
            });
          }
        }
        break;

      case "spawn":
        if (ev.parent === id) {
          // 在 child_handles 里记录新的子节点
          this.memory.child_handles.push({
            agent_id: ev.child,
            status: "running",
            goal: ev.goal,
            handup: null,
          });
          this.saveAsync();
        }
        break;

      case "agent.done":
        if (ev.agent === id) {
          this._inflightTools.clear(); // M1-8: a completed agent has no pending 现场
          this.memory.tombstone.pending_tool_calls = undefined;
          this.memory.tombstone.final_status = ev.success ? "done" : "error";
          const recentFacts = this.memory.working_set.facts
            .slice(-5)
            .map((f) => f.text)
            .join("; ");
          this.memory.tombstone.compact_summary =
            `${ev.reason ?? (ev.success ? "done" : "failed")} | ${recentFacts}`.slice(0, 500);
          this.memory.tombstone.resume_hint = null;
          this.flushSync();
          this.stopTimer();
          // 通知 TUI 已写入快照
          this.emit("event", {
            v: 1,
            type: "memory.snapshot",
            agent: id,
            path: `.spawn/memory/${id}.json`,
            size_kb: Math.round(JSON.stringify(this.memory).length / 1024 * 10) / 10,
          } as TuiEvent);
        }
        // 更新 parent 的 child_handles
        {
          const handle = this.memory.child_handles.find((h) => h.agent_id === ev.agent);
          if (handle) {
            handle.status = ev.success ? "done" : "error";
            this.saveAsync();
          }
        }
        break;

      case "agent.error":
        if (ev.agent === id) {
          this.memory.tombstone.final_status = "error";
          this.memory.tombstone.compact_summary =
            `Error: ${ev.code}${ev.detail ? " - " + ev.detail : ""}`.slice(0, 300);
          this.flushSync();
        }
        break;
    }
  }

  /** httpAgent 每次 send() 完成后调用 — 持久化对话记录 */
  observeMessage(role: "user" | "assistant", content: string): void {
    if (this.destroyed) return;
    appendMessage(this.memory.agent_id, { role, content, ts: Date.now() });
    // 更新 resume hint — assistant turns are raw protocol JSON, extract prose only
    if (role === "assistant") {
      const prose = content.split("\n")
        .filter((l) => !l.trim().startsWith("{"))
        .join(" ")
        .trim()
        .slice(0, 120);
      this.memory.tombstone.resume_hint = prose
        ? `Last assistant: ${prose}`
        : "Last assistant: (protocol-only turn)";
    } else {
      this.memory.tombstone.resume_hint = `Last user: ${content.slice(0, 120)}`;
    }
    this.memory.updated_at = Date.now();
  }

  getMemory(): Readonly<AgentMemory> { return this.memory; }

  /** Bus log offset at last flush — replay getLog(cursor) to recover state since last snapshot. */
  getLogCursor(): number { return this._logCursor; }

  /**
   * PM-Secretary calls this when a child Leader (Tech Lead) completes.
   * Pulls the TL's top facts/decisions up into PM's working_set so PM
   * has cross-task context without reading every child file.
   */
  ingestChildMemory(childMem: AgentMemory): void {
    if (this.destroyed) return;
    for (const f of topFactsByWeight(childMem, 5)) {
      this.addFact({
        id: `f${++this.factSeq}`,
        text: `[${childMem.agent_id}] ${f.text}`,
        src: `handup:${childMem.agent_id}`,
        ts: Date.now(),
      });
    }
    for (const d of childMem.working_set.decisions.slice(-3)) {
      this.addDecision({
        id: `d${++this.decisionSeq}`,
        text: `[${childMem.agent_id}] ${d.text}`,
        rationale: d.rationale,
        ts: Date.now(),
      });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.flushSync();
    this.destroyed = true;
    this.emit("destroy");
    this.stopTimer();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private handleBtw(text: string): void {
    this.addFact({
      id: `f${++this.factSeq}`,
      text: `[btw] ${text}`,
      src: "btw:user",
      ts: Date.now(),
    });
    if (TIME_KEYWORDS.test(text)) {
      appendReminder(text, Date.now());
    }
  }

  private addFact(fact: MemoryFact): void {
    const facts = this.memory.working_set.facts;
    // Lexical similarity is for retrieval, never for destructive deduplication.
    // Negation and changed conditions can be almost identical to the old claim.
    const now = Date.now();

    // Merge only exact normalized repeats
    let merged = false;
    for (let i = 0; i < facts.length; i++) {
      const existing = facts[i];
      if (existing.text.normalize("NFKC").trim() === fact.text.normalize("NFKC").trim()) {
        // Merge: bump weight, update text to the longer one, refresh ts
        const previousWeight = existing.weight ?? 1;
        const newWeight = (existing.weight ?? 1) + (fact.weight ?? 1);
        existing.weight = newWeight;
        if (fact.text.length > existing.text.length) {
          existing.text = fact.text;
        }
        existing.ts = now;
        recordHealthMetric({
          agent_id: this.memory.agent_id,
          event_type: "memory_fact_merged",
          severity: "info",
          reason: "similar_fact_merged",
          refs: [existing.text.slice(0, 300), fact.text.slice(0, 300)],
          meta: {
            existingFactId: existing.id,
            incomingFactId: fact.id,
            previousWeight,
            newWeight,
            src: fact.src,
          },
        });
        merged = true;
        break;
      }
    }

    if (!merged) {
      facts.push({ ...fact, weight: fact.weight ?? 1 });
    }
    this.gc();
    this.saveAsync();
  }

  private addDecision(d: MemoryDecision): void {
    if (this.memory.working_set.decisions.at(-1)?.text === d.text) return;
    this.memory.working_set.decisions.push(d);
    this.saveAsync();
  }

  private gc(): void {
    const facts = this.memory.working_set.facts;
    if (facts.length <= 50) return;
    const before = facts.slice();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = facts.filter((f) => f.ts > cutoff);
    // 保留至少 20 条，丢弃最旧的重复 src
    this.memory.working_set.facts = recent.length < 20
      ? facts.slice(-50)
      : recent.slice(-50);
    const kept = new Set(this.memory.working_set.facts.map((f) => f.id));
    const dropped = before.filter((f) => !kept.has(f.id));
    if (dropped.length > 0) {
      archiveFacts(this.memory.agent_id, dropped); // M3-1: keep in cold archive, not lost
      recordHealthMetric({
        agent_id: this.memory.agent_id,
        event_type: "memory_fact_dropped",
        severity: "warn",
        reason: "working_set_fact_gc",
        refs: dropped.slice(0, 5).map((f) => f.text.slice(0, 300)),
        meta: {
          droppedCount: dropped.length,
          beforeCount: before.length,
          afterCount: this.memory.working_set.facts.length,
        },
      });
    }
  }

  private saveAsync(): void {
    // Snapshot cursor + epoch at decision time, not inside setImmediate, so the
    // tombstone accurately reflects "state as of this moment" for gap detection.
    const cursor = globalBus.getHeadOffset();
    const epoch  = globalBus.getEpoch();
    this._logCursor = cursor;
    this.memory.tombstone.log_cursor = cursor;
    this.memory.tombstone.log_cursor_epoch = epoch;
    this.memory.tombstone.pending_tool_calls = this._inflightTools.size ? [...this._inflightTools.values()] : undefined;
    this.memory.updated_at = Date.now();
    setImmediate(() => {
      if (!this.destroyed) saveMemory(this.memory.agent_id, this.memory);
    });
  }

  private flushSync(): void {
    const cursor = globalBus.getHeadOffset();
    const epoch  = globalBus.getEpoch();
    this._logCursor = cursor;
    this.memory.tombstone.log_cursor = cursor;
    this.memory.tombstone.log_cursor_epoch = epoch;
    this.memory.tombstone.pending_tool_calls = this._inflightTools.size ? [...this._inflightTools.values()] : undefined;
    this.memory.updated_at = Date.now();
    saveMemory(this.memory.agent_id, this.memory);
  }

  private stopTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }
}

export function factSimilarity(a: string, b: string): number {
  const sa = factTokens(a);
  const sb = factTokens(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersect = 0;
  for (const token of sa) {
    if (sb.has(token)) intersect++;
  }
  const union = sa.size + sb.size - intersect;
  const jaccard = union === 0 ? 0 : intersect / union;
  const minSize = Math.min(sa.size, sb.size);
  const containment = minSize >= 4 ? intersect / minSize : 0;
  return Math.max(jaccard, containment);
}

export function factTokens(input: string): Set<string> {
  const normalized = input
    .toLowerCase()
    .replace(/[\u3000\s]+/g, " ")
    .replace(/[，。！？；：、“”‘’（）【】《》,.!?;:"'()[\]{}<>]/g, " ")
    .trim();
  const tokens = new Set<string>();
  if (!normalized) return tokens;

  const asciiParts = normalized.match(/[a-z0-9_./:-]+/g) ?? [];
  for (const part of asciiParts) {
    if (part.length >= 2) tokens.add(part);
  }

  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  for (const run of cjkRuns) {
    const compactRun = normalizeCjkRun(run);
    if (!compactRun) continue;
    addCharNgrams(tokens, compactRun, 1);
    addCharNgrams(tokens, compactRun, 2);
    addCharNgrams(tokens, compactRun, 3);
  }

  if (tokens.size === 0) {
    const compact = normalized.replace(/\s+/g, "");
    addCharNgrams(tokens, compact, compact.length <= 4 ? 1 : 2);
  }
  return tokens;
}

function normalizeCjkRun(run: string): string {
  return run
    .replace(/(需要|必须|应该|应当|可以|能够|进行|通过|已经|当前|这个|那个|一种|一个)/g, "")
    .replace(/[的在是了要]/g, "");
}

function addCharNgrams(tokens: Set<string>, text: string, size: number): void {
  const chars = Array.from(text);
  if (chars.length === 0) return;
  if (chars.length < size) {
    tokens.add(chars.join(""));
    return;
  }
  for (let i = 0; i <= chars.length - size; i++) {
    tokens.add(chars.slice(i, i + size).join(""));
  }
}
