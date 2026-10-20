import { sessionJournal } from "../session/Journal.js";
import { writeSnapshot } from "./atomic.js";
// MemoryStore — 唯一的 .spawn/memory/ I/O 层
// 原子写（tmp + rename）+ fsync，防止半写状态被 resume 读到

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentMemory, MemoryFact } from "./types.js";

function memoryDir(): string {
  return path.resolve(process.cwd(), ".spawn", "memory");
}

export function ensureMemoryDir(): void {
  fs.mkdirSync(memoryDir(), { recursive: true });
}

export function memoryPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.json`);
}

export function messagesPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.messages.jsonl`);
}

/** New session-history file (replaces flat .messages.jsonl). */
export function sessionsPath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.sessions.json`);
}

/** M3-1: cold-fact archive — facts evicted from the working set are kept here
 *  (append-only JSONL) instead of being lost, so goal-relevance retrieval can
 *  still surface them. */
export function archivePath(agentId: string): string {
  return path.join(memoryDir(), `${agentId}.archive.jsonl`);
}

/** Append evicted facts to the archive (best-effort, never throws). */
export function archiveFacts(agentId: string, facts: MemoryFact[]): void {
  if (!facts.length) return;
  try {
    fs.mkdirSync(memoryDir(), { recursive: true });
    fs.appendFileSync(archivePath(agentId), facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");
  } catch { /* archive is best-effort */ }
}

/** Load archived facts (most-recent `cap`), skipping corrupt lines. */
export function loadArchivedFacts(agentId: string, cap = 500): MemoryFact[] {
  try {
    const lines = fs.readFileSync(archivePath(agentId), "utf8").split(/\r?\n/);
    const out: MemoryFact[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as MemoryFact); } catch { /* skip corrupt */ }
    }
    return out.slice(-cap);
  } catch { return []; }
}

export function remindersPath(): string {
  return path.join(memoryDir(), "reminders.json");
}

export function loadMemory(agentId: string): AgentMemory | null {
  let legacy: AgentMemory | null = null;
  try { legacy = JSON.parse(fs.readFileSync(memoryPath(agentId), "utf8")) as AgentMemory; } catch { /* replay source below */ }
  const journal = sessionJournal(), binding = journal.binding(agentId);
  if (!binding) return legacy;
  const state = journal.current(binding.conversation)!;
  const parentChain: string[] = [];
  let parent = binding.parent;
  while (parent && parentChain.length < 16) { parentChain.unshift(parent); parent = journal.binding(parent)?.parent; }
  const mem = legacy ?? createMemory({ agentId, agentType: binding.parent ? binding.role === "Worker" ? "WORKER" : "LEADER" : "PM", parentChain, depth: parentChain.length, model: "configured-at-resume", roleName: binding.role });
  if (!legacy) mem.session_hash = crypto.createHash("sha256").update(`journal:${agentId}`).digest("hex").slice(0, 7);
  mem.dispatch = { ...mem.dispatch, ...binding.dispatch, background: binding.parent ? binding.goal : state.goal, constraints: state.constraints };
  mem.working_set.decisions = state.decisions.map((d) => ({ id: `event-${d.seq}`, text: d.text, rationale: "durable event", ts: state.updatedAt }));
  mem.working_set.facts = state.facts.map((f) => ({ id: `event-${f.seq}`, text: f.text, src: `event:${f.seq}`, ts: state.updatedAt, weight: 1 }));
  mem.tombstone.last_todo = JSON.stringify(state.todos);
  mem.tombstone.pending_tool_calls = Object.entries(state.tools).filter(([, t]) => t.agent === agentId && t.status !== "completed").map(([id, t]) => ({ id, name: t.name, args: t.args }));
  if (!mem.tombstone.pending_tool_calls.length) mem.tombstone.pending_tool_calls = undefined;
  mem.tombstone.resume_hint = `Current requirement revision ${state.revision}; verify uncertain effects before retrying`;
  mem.tombstone.final_status = binding.status === "done" ? "done" : binding.status === "failed" ? "error" : null;
  return mem;
}

export function saveMemory(agentId: string, mem: AgentMemory): void {
  ensureMemoryDir();
  const p = memoryPath(agentId);
  const content = JSON.stringify(mem, null, 2);
  try { writeSnapshot(p, content); }
  catch (error) { process.stderr.write(`[memory] snapshot failed for ${agentId}: ${String(error)}\n`); }

}

// ── Session-based message history ────────────────────────────────────────────

/** Max number of sessions kept per agent. Oldest evicted when exceeded. */
export const MAX_SESSIONS = 5;

export interface SessionEntry {
  session_hash: string;
  started_at: number;
  messages: Array<{ role: "user" | "assistant"; content: string; ts: number }>;
}

function loadSessionsRaw(agentId: string): SessionEntry[] {
  try {
    return JSON.parse(fs.readFileSync(sessionsPath(agentId), "utf8")) as SessionEntry[];
  } catch { return []; }
}

function writeSessions(agentId: string, sessions: SessionEntry[]): void {
  const p = sessionsPath(agentId);
  writeSnapshot(p, JSON.stringify(sessions));

}

/**
 * Called when a new agent run begins (SecretaryProxy constructor).
 * Appends a new empty session, evicting the oldest if MAX_SESSIONS exceeded.
 */
export function startSession(agentId: string, sessionHash: string): void {
  ensureMemoryDir();
  try {
    const sessions = loadSessionsRaw(agentId);
    const entry: SessionEntry = { session_hash: sessionHash, started_at: Date.now(), messages: [] };
    writeSessions(agentId, [...sessions, entry].slice(-MAX_SESSIONS));
  } catch { /* best-effort */ }
}

/** Append a message to the current (last) session. */
export function appendMessage(
  agentId: string,
  msg: { role: "user" | "assistant"; content: string; ts: number },
): void {
  ensureMemoryDir();
  try {
    const sessions = loadSessionsRaw(agentId);
    if (sessions.length === 0) {
      // No startSession called yet — create an implicit session
      sessions.push({ session_hash: "implicit", started_at: Date.now(), messages: [] });
    }
    sessions[sessions.length - 1].messages.push(msg);
    // Managed sessions keep complete messages in the append-only journal.
    // Bound compatibility snapshots so a long conversation does not rewrite
    // an ever-growing transcript on every message.
    if (sessionJournal().binding(agentId)) {
      for (const session of sessions) session.messages = session.messages.slice(-50).map((message) => ({
        ...message, content: message.content.length <= 24000 ? message.content : message.content.slice(0, 12000) + "\n[full event available via SessionRecall]\n" + message.content.slice(-12000),
      }));
    }
    writeSessions(agentId, sessions);
  } catch { /* EPERM / locked file on Windows — memory write is best-effort */ }
}

/** Returns all messages from the most recent session (used for resume context). */
export function loadMessages(
  agentId: string,
): Array<{ role: "user" | "assistant"; content: string; ts: number }> {
  try {
    const sessions = loadSessionsRaw(agentId);
    return sessions.length > 0 ? sessions[sessions.length - 1].messages : [];
  } catch { return []; }
}

/** Returns all stored sessions for this agent (newest last). */
export function loadSessions(agentId: string): SessionEntry[] {
  return loadSessionsRaw(agentId);
}

// ── Lookup & lifecycle ────────────────────────────────────────────────────────

/** 通过 7-char session_hash 查找 AgentMemory */
export function loadMemoryByHash(hash: string): AgentMemory | null {
  try {
    ensureMemoryDir();
    for (const f of fs.readdirSync(memoryDir())) {
      if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(memoryDir(), f), "utf8")) as AgentMemory;
        if (m.session_hash === hash) return m;
      } catch { /* skip corrupt file */ }
    }
    for (const binding of sessionJournal().bindings()) {
      const memory = loadMemory(binding.id);
      if (memory?.session_hash === hash) return memory;
    }
    return null;
  } catch { return null; }
}

/** 扫描所有 tombstone.final_status === null 的 agent（未正常退出）*/
export function listUnfinishedAgents(): AgentMemory[] {
  ensureMemoryDir();
  const ids = new Set<string>();
  for (const file of fs.readdirSync(memoryDir())) if (file.endsWith(".json") && !file.endsWith(".sessions.json")) ids.add(file.slice(0, -5));
  for (const binding of sessionJournal().bindings()) if (binding.status === "running" || binding.status === "interrupted") ids.add(binding.id);
  return [...ids].map((id) => loadMemory(id)).filter((mem): mem is AgentMemory => !!mem && mem.tombstone.final_status === null && sessionJournal().isCurrent(mem.agent_id));
}

/**
 * Called on agent.done. Deletes the working-set .json (no longer needed).
 * The .sessions.json is intentionally kept for future resume.
 */
export function deleteAgentMemory(agentId: string): void {
  try { fs.unlinkSync(memoryPath(agentId)); } catch { /* already gone */ }
  // sessions file is kept — evicted naturally when MAX_SESSIONS is exceeded
}

/** 追加 btw 提醒到 reminders.json */
export function appendReminder(text: string, ts: number): void {
  ensureMemoryDir();
  const p = remindersPath();
  let reminders: Array<{ text: string; ts: number }> = [];
  try { reminders = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* fresh file */ }
  reminders.push({ text, ts });
  fs.writeFileSync(p, JSON.stringify(reminders, null, 2), "utf8");
}

// ── Jaccard similarity for weighted dedup (P1) ──────────────────────────────

/** Tokenize text into lowercase word set */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-zA-Z0-9_\u4e00-\u9fff]+/).filter(Boolean),
  );
}

/** Jaccard similarity coefficient between two strings */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** Jaccard threshold above which two facts are considered duplicates */
export const JACCARD_THRESHOLD = 0.7;

/**
 * Add a fact to working_set.facts with Jaccard-weighted dedup (P1).
 * If a similar fact (Jaccard >= 0.7) exists, merge by incrementing weight.
 * Otherwise, append with weight = 1 (or provided weight).
 */
export function addFact(
  mem: AgentMemory,
  text: string,
  src: string,
  weight: number = 1,
): void {
  const idx = mem.working_set.facts.findIndex(
    (f) => jaccardSimilarity(f.text, text) >= JACCARD_THRESHOLD,
  );
  if (idx >= 0) {
    // Merge: increment weight, update src and ts
    const existing = mem.working_set.facts[idx];
    existing.weight = (existing.weight ?? 1) + weight;
    existing.src = src;
    existing.ts = Date.now();
  } else {
    // Append new fact
    mem.working_set.facts.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      src,
      ts: Date.now(),
      weight,
    });
  }
}

/**
 * Get top-N facts by weight (descending). Used for resume context injection (P1).
 */
export function topFactsByWeight(mem: AgentMemory, n: number = 10): MemoryFact[] {
  return [...mem.working_set.facts]
    .sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
    .slice(0, n);
}

/** 构建一个全新 AgentMemory 对象（spawn 时初始化） */
export function createMemory(opts: {
  agentId: string;
  agentType: "PM" | "LEADER" | "SECRETARY" | "WORKER";
  parentChain: string[];
  depth: number;
  model: string;
  roleName: string;
  dispatch?: {
    background: string;
    constraints: string[];
    acceptance_criteria: string[];
    stop_conditions: string[];
  };
}): AgentMemory {
  const created_at = Date.now();
  const session_hash = crypto
    .createHash("sha256")
    .update(`${opts.agentId}_${created_at}`)
    .digest("hex")
    .slice(0, 7);

  return {
    schema_version: 1,
    agent_id: opts.agentId,
    agent_type: opts.agentType,
    session_hash,
    parent_chain: opts.parentChain,
    depth: opts.depth,
    created_at,
    updated_at: created_at,
    identity: { role_name: opts.roleName, skills: [], model: opts.model },
    dispatch: opts.dispatch ?? {
      background: "",
      constraints: [],
      acceptance_criteria: [],
      stop_conditions: [],
    },
    working_set: { facts: [], decisions: [], open_questions: [] },
    child_handles: [],
    tombstone: {
      compact_summary: null,
      final_status: null,
      final_artifacts: [],
      resume_hint: null,
    },
  };
}
