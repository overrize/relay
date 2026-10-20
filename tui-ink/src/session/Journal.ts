import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeSnapshot } from "../memory/atomic.js";
import { loadRetention, storagePolicy, parseEvents, decodeArchive, digest, zip, writeBuffer, isMemoryEvent, directoryBytes, yieldIO, unlinkManaged, cleanAbandonedDrafts, type RetentionBase, type ArchiveRef, type StoragePolicy } from "./Storage.js";
import { HistoryIndex, type SearchSource, type SearchStats } from "./SearchIndex.js";
import { cleanCompletedProcesses } from "./completedProcesses.js";
import { createBackup, type BackupFile } from "./Backup.js";
import { reduceTask, type WorkItem } from "./Tasks.js";
import { reduceBudget, type SessionBudget } from "./Budget.js";

export interface Entry {
  version: 1; seq: number; id: string; ts: number; kind: string;
  conversation: string; agent: string; revision: number; data: any; hash: string;
}
export interface Binding {
  id: string; conversation: string; parent?: string; role: string; revision: number;
  goal: string; dispatch?: any; status: "running" | "done" | "failed" | "superseded" | "interrupted";
  outcome?: { seq: number; reason: string; summary: string; evidence: string[]; remaining: string[]; artifacts: string[]; reportedSuccess?: boolean; lastError?: string };
  lastError?: string;
  modelSelection?: { candidate?: string; model: string; transport: string; billing: string; at: number };
  todos?: any[];
  workId?: string;
}
export interface PendingInput { id: string; text: string; revision: number; agent?: string; kind?: string; status: "pending" | "started" | "done" | "superseded" }
export interface CurrentState {
  id: string; revision: number; goal: string; constraints: string[]; updatedAt: number;
  todos: any[]; decisions: Array<{ text: string; seq: number }>;
  facts: Array<{ text: string; seq: number; agent: string }>;
  tools: Record<string, { name: string; args: unknown; agent: string; revision: number; status: "pending" | "completed" | "uncertain"; output?: string; ok?: boolean; completedSeq?: number; verifiedExecution?: boolean }>;
  inputs: PendingInput[];
  work?: Record<string, WorkItem>;
}
export interface Projection {
  budget?: SessionBudget;
  seq: number; lastHash: string; agents: Record<string, Binding>; conversations: Record<string, CurrentState>;
  history: Record<string, Array<{ role: "user" | "assistant"; content: string; revision: number }>>;
  inbox: Record<string, { id: string; conversation: string; agent: string; text: string; channel: string; metadata: any }>;
}
const empty = (): Projection => ({ seq: 0, lastHash: "", agents: {}, conversations: {}, history: {}, inbox: {} });
function hash(entry: Omit<Entry, "hash">, previous: string) {
  return createHash("sha256").update(previous + JSON.stringify(entry)).digest("hex");
}
interface Segment { name: string; size: number; mtimeMs: number; ctimeMs: number }
interface Checkpoint { version: 2 | 3; baseGeneration?: number; segments: Segment[]; state: Projection; digest: string }
const checksum = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const segmentPattern = /^(\d{16})-(\d{16})\.jsonl$/;
interface Source extends SearchSource { file: string; archive?: ArchiveRef; size: number }
export interface MaintenanceReport { compactedSegments: number; deletedLogBytes: number; archiveBytes: number; indexBytes: number; logBytes: number; totalBytes: number; overQuota: boolean; completedProcesses: number; errors: string[]; backup?: { directory: string; id: string; seq: number; files: number } }
const maintenance = new Map<string, Promise<MaintenanceReport>>();

/** Append-only, fsynced source of truth. Snapshots are disposable projections. */
export class SessionJournal {
  private state = empty();
  private offset = 0;
  private initialized = false;
  private directoryStamp = "";
  private activeStamp = "";
  private segments: Segment[] = [];
  private segmentStart = 1;
  private base?: RetentionBase;
  private baseStamp = "";
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private maintenanceDue = 0;
  private effectivePolicy?: StoragePolicy;
  lastMaintenance?: MaintenanceReport;
  lastSearch: SearchStats = { sourcesVisited: 0, indexHits: 0, candidateEvents: 0, bytesRead: 0, rebuilt: 0 };
  readonly stats = { checkpointUsed: false, replayedEvents: 0, bytesRead: 0 };
  readonly file: string;
  private readonly segmentDirectory: string;
  constructor(readonly root = process.cwd(), private readonly options: { segmentBytes?: number; verifyHistory?: boolean; automatic?: boolean; policy?: Partial<StoragePolicy>; allowRestoreTransaction?: boolean } = {}) {
    if (!options.allowRestoreTransaction && fs.existsSync(path.join(root, ".spawn", "restore-transaction.json"))) throw new Error("Interrupted restore detected; finish restore repair before starting the application");
    this.file = path.join(root, ".spawn", "events", "journal.jsonl");
    this.segmentDirectory = path.join(path.dirname(this.file), "segments");
    this.refresh();
  }
  private stamp(file: string) {
    try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (e: any) { if (e.code === "ENOENT") return ""; throw e; }
  }
  private readSegments(): Segment[] {
    let names: string[];
    try { names = fs.readdirSync(this.segmentDirectory); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
    const result = names.filter((name) => segmentPattern.test(name) && Number(segmentPattern.exec(name)![2]) > (this.base?.state.seq ?? 0)).sort().map((name) => {
      const stat = fs.statSync(path.join(this.segmentDirectory, name));
      return { name, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    });
    const remaining = result.filter((s) => Number(segmentPattern.exec(s.name)![2]) > (this.base?.state.seq ?? 0));
    let next = (this.base?.state.seq ?? 0) + 1;
    for (const s of remaining) {
      const match = segmentPattern.exec(s.name)!;
      if (Number(match[1]) !== next || Number(match[2]) < next) throw new Error("Session journal segment sequence has a gap; no execution allowed");
      next = Number(match[2]) + 1;
    }
    return remaining;
  }
  private replay(bytes: Buffer, state: Projection, sealed: boolean) {
    this.stats.bytesRead += bytes.length;
    const boundary = bytes.lastIndexOf(10) + 1;
    if (sealed && boundary !== bytes.length) throw new Error("Sealed journal segment has a torn record");
    for (const line of bytes.subarray(0, boundary).toString("utf8").split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as Entry;
      const { hash: digest, ...body } = event;
      if (event.version !== 1 || event.seq !== state.seq + 1 || hash(body, state.lastHash) !== digest) throw new Error(`Session journal integrity failure at sequence ${state.seq + 1}; no execution allowed`);
      reduce(state, event); this.stats.replayedEvents++;
    }
    return boundary;
  }
  private restore(segments: Segment[]) {
    let state = this.base ? structuredClone(this.base.state) : empty(), skip = 0, missingSegments = false;
    try {
      const cp = JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), "checkpoint.json"), "utf8")) as Checkpoint;
      const { digest, ...body } = cp;
      const valid = (cp.version === 2 || cp.version === 3) && (cp.baseGeneration ?? 0) === (this.base?.generation ?? 0) && cp.segments.length > 0 && checksum(body) === digest;
      if (valid) { const present = new Set(segments.map((s) => s.name)); missingSegments = cp.segments.some((s) => !present.has(s.name)); }
      if (valid && !this.options.verifyHistory && process.env.SPAWN_VERIFY_JOURNAL !== "1" &&
          JSON.stringify(segments.slice(0, cp.segments.length)) === JSON.stringify(cp.segments) &&
          Number(segmentPattern.exec(cp.segments.at(-1)!.name)![2]) === cp.state.seq) {
        // Validate the immutable boundary as well as the checkpoint checksum.
        const last = cp.segments.at(-1)!, file = path.join(this.segmentDirectory, last.name);
        const fd = fs.openSync(file, "r");
        let count = Math.min(last.size, 8192), tail = Buffer.alloc(count);
        try {
          while (true) {
            tail = Buffer.alloc(count); fs.readSync(fd, tail, 0, count, last.size - count); this.stats.bytesRead += count;
            if (count === last.size || tail.subarray(0, -1).lastIndexOf(10) >= 0) break;
            count = Math.min(last.size, count * 2);
          }
        } finally { fs.closeSync(fd); }
        const lines = tail.toString("utf8").trimEnd().split("\n");
        const anchor = JSON.parse(lines.at(-1)!);
        const { hash: anchorHash } = anchor;
        if (anchor.version === 1 && anchor.seq === cp.state.seq && anchorHash === cp.state.lastHash) {
          state = cp.state; skip = cp.segments.length; this.stats.checkpointUsed = true;
        }
      }
    } catch { /* Missing or invalid disposable checkpoint: verify the source log. */ }
    if (missingSegments) throw new Error("Session journal checkpoint references missing sealed segments; no execution allowed");
    for (const segment of segments.slice(skip)) {
      this.replay(fs.readFileSync(path.join(this.segmentDirectory, segment.name)), state, true);
      if (state.seq !== Number(segmentPattern.exec(segment.name)![2])) throw new Error("Sealed journal segment boundary mismatch");
    }
    this.state = state; this.offset = 0; this.activeStamp = "";
    this.segments = segments; this.segmentStart = state.seq + 1;
  }
  private refresh() {
    const directoryStamp = this.stamp(this.segmentDirectory);
    const activeStamp = this.stamp(this.file);
    const baseStamp = this.stamp(path.join(path.dirname(this.file), "retention.json")) + this.stamp(path.join(path.dirname(this.file), "retention.backup.json"));
    if (!this.initialized || directoryStamp !== this.directoryStamp || baseStamp !== this.baseStamp) {
      this.base = loadRetention(path.dirname(this.file)); this.baseStamp = baseStamp;
      this.restore(this.readSegments()); this.directoryStamp = directoryStamp; this.initialized = true;
    }
    // Windows can defer directory timestamp updates after rename. The active
    // file identity/disappearance is also a rotation signal.
    if (this.offset && (!activeStamp || (this.activeStamp && activeStamp.split(":")[0] !== this.activeStamp.split(":")[0]) || fs.statSync(this.file).size < this.offset)) {
      const segments = this.readSegments();
      if (JSON.stringify(segments) === JSON.stringify(this.segments)) throw new Error("Active session journal disappeared or was replaced; no execution allowed");
      this.restore(segments); this.directoryStamp = directoryStamp;
    }
    if (activeStamp === this.activeStamp) return;
    if (!activeStamp) { if (this.offset) throw new Error("Active session journal disappeared; no execution allowed"); return; }
    const size = fs.statSync(this.file).size;
    if (size < this.offset) throw new Error("Active session journal was truncated; no execution allowed");
    // Only read appended bytes. A changed file of the same size is reverified.
    if (size === this.offset) { this.restore(this.segments); }
    const bytes = Buffer.alloc(size - this.offset), fd = fs.openSync(this.file, "r");
    try { fs.readSync(fd, bytes, 0, bytes.length, this.offset); } finally { fs.closeSync(fd); }
    const next = structuredClone(this.state);
    const count = this.replay(bytes, next, false);
    this.state = next; this.offset += count; this.activeStamp = activeStamp;
  }
  private rotate(force = false) {
    if (!this.offset || (!force && this.offset < (this.options.segmentBytes ?? 4 * 1024 * 1024))) return;
    fs.mkdirSync(this.segmentDirectory, { recursive: true });
    const name = `${String(this.segmentStart).padStart(16, "0")}-${String(this.state.seq).padStart(16, "0")}.jsonl`;
    fs.renameSync(this.file, path.join(this.segmentDirectory, name));
    const segments = this.readSegments();
    const body = { version: 3 as const, baseGeneration: this.base?.generation ?? 0, segments, state: this.state };
    try { writeSnapshot(path.join(path.dirname(this.file), "checkpoint.json"), JSON.stringify({ ...body, digest: checksum(body) })); }
    catch (error) { process.stderr.write(`[session] checkpoint failed; full replay remains available: ${String(error)}\n`); }
    this.segments = segments; this.segmentStart = this.state.seq + 1;
    this.offset = 0; this.activeStamp = ""; this.directoryStamp = this.stamp(this.segmentDirectory);
    this.scheduleMaintenance(1000);
  }
  private locked<T>(work: () => T, durable = true): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      let owner: number;
      try { owner = Number(fs.readFileSync(lock, "utf8")); } catch { throw new Error("Session journal lock unavailable"); }
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("Invalid session journal lock; inspect before retrying");
      try { process.kill(owner, 0); } catch (e: any) {
        if (e.code !== "ESRCH") throw e;
        fs.unlinkSync(lock);
        return this.locked(work);
      }
      throw new Error("Another process is writing this session; retry later");
    }
    try {
      fs.writeFileSync(fd, String(process.pid)); if (durable) fs.fsyncSync(fd);
      this.refresh();
      // Preserve the torn bytes for inspection before removing an incomplete append.
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (durable && size > this.offset) {
        fs.writeFileSync(`${this.file}.torn-${randomUUID()}`, fs.readFileSync(this.file).subarray(this.offset));
        fs.truncateSync(this.file, this.offset);
      }
      return work();
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  append(kind: string, conversation: string, agent: string, revision: number, data: any): Entry {
    return this.locked(() => {
      const body = { version: 1 as const, seq: this.state.seq + 1, id: randomUUID(), ts: Date.now(), kind, conversation, agent, revision, data };
      const event: Entry = { ...body, hash: hash(body, this.state.lastHash) };
      const line = JSON.stringify(event) + "\n";
      const fd = fs.openSync(this.file, "a", 0o600);
      try { fs.writeFileSync(fd, line, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      reduce(this.state, event); this.offset += Buffer.byteLength(line);
      this.activeStamp = this.stamp(this.file);
      if (event.seq % 32 === 0 || kind === "requirement.changed") {
        try { writeSnapshot(path.join(path.dirname(this.file), "current.json"), JSON.stringify(this.state)); }
        catch (error) { process.stderr.write(`[session] projection checkpoint failed: ${String(error)}\n`); }
      }
      this.rotate();
      return event;
    });
  }
  binding(id: string): Binding | undefined { this.refresh(); return structuredClone(this.state.agents[id]); }
  budget() { this.refresh(); return structuredClone(this.state.budget); }
  sequence() { this.refresh(); return { seq: this.state.seq, lastHash: this.state.lastHash }; }
  async backup() {
    const capture = this.locked(() => {
      if (!this.state.seq) throw new Error("No session events to back up");
      const directory = path.dirname(this.file), files: BackupFile[] = [];
      for (const source of this.sources().filter((s) => s.persistent)) files.push({ name: path.relative(directory, source.file).split(path.sep).join("/"), file: source.file });
      if (this.base) {
        const bytes = Buffer.from(JSON.stringify(this.base));
        for (const name of ["retention.json", "retention.backup.json"]) files.push({ name, bytes });
      }
      if (this.offset) {
        const bytes = fs.readFileSync(this.file).subarray(0, this.offset);
        files.push({ name: `segments/${String(this.segmentStart).padStart(16, "0")}-${String(this.state.seq).padStart(16, "0")}.jsonl`, bytes });
      }
      const pin = path.join(directory, "backup-pins", `${randomUUID()}.json`);
      writeSnapshot(pin, JSON.stringify({ pid: process.pid, files: files.map((f) => f.name), createdAt: Date.now() }));
      return { seq: this.state.seq, lastHash: this.state.lastHash, files, pin };
    });
    try { return await createBackup(this.root, capture.seq, capture.lastHash, capture.files); }
    finally { await unlinkManaged(this.root, capture.pin); }
  }
  current(id: string): CurrentState | undefined { this.refresh(); return structuredClone(this.state.conversations[id]); }
  history(id: string) { this.refresh(); return structuredClone(this.state.history[id] ?? []); }
  bindings() { this.refresh(); return structuredClone(Object.values(this.state.agents)); }
  tasks(conversation: string) { this.refresh(); return structuredClone(Object.values(this.state.agents).filter((a) => a.conversation === conversation && a.parent)); }
  currentRevision(id: string) { const b = this.binding(id); return b ? this.current(b.conversation)?.revision : undefined; }
  isCurrent(id: string, revision?: number) {
    const binding = this.binding(id);
    if (!binding) return true; // Legacy low-level callers remain usable.
    return binding.status !== "superseded" && (revision ?? binding.revision) === this.current(binding.conversation)?.revision;
  }
  bind(id: string, role: string, parent?: string, goal = "", dispatch?: any): Binding {
    const existing = this.binding(id);
    if (existing) return existing;
    const owner = parent ? this.binding(parent) : undefined;
    const conversation = owner?.conversation ?? id;
    const revision = this.current(conversation)?.revision ?? 0;
    this.append("agent.bound", conversation, id, revision, { id, role, parent, goal, dispatch });
    return this.binding(id)!;
  }
  pending(id: string) { const b = this.binding(id); return b ? this.current(b.conversation)?.inputs.filter((i) => (i.agent === id || (!i.agent && !b.parent)) && (i.status === "pending" || i.status === "started")) ?? [] : []; }
  acceptNotice(agent: string, id: string, text: string, revision?: number) {
    const b = this.binding(agent); if (!b || !this.isCurrent(agent, revision)) return undefined;
    const state = this.current(b.conversation)!, prior = state.inputs.find((i) => i.id === id); if (prior) return prior;
    this.append("input.accepted", b.conversation, agent, state.revision, { inputId: id, text, kind: "runtime-notice" });
    return { id, text, revision: state.revision, status: "pending" as const };
  }
  queued(channel: string) { this.refresh(); return structuredClone(Object.values(this.state.inbox).filter((i) => i.channel === channel)); }
  dispatched(id: string) {
    this.refresh(); const input = this.state.inbox[id];
    if (input) this.append("inbox.dispatched", input.conversation, input.agent, this.current(input.conversation)?.revision ?? 0, { id });
  }
  scheduleMaintenance(delay = 60000): void {
    if (!this.options.automatic) return;
    if (this.maintenanceTimer) {
      if (this.maintenanceDue <= Date.now() + delay) return;
      clearTimeout(this.maintenanceTimer);
    }
    this.maintenanceDue = Date.now() + delay;
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      if (!fs.existsSync(path.dirname(this.file))) return;
      void this.maintain().catch((error) => process.stderr.write(`[storage] ${String(error)}\n`)).finally(() => this.scheduleMaintenance());
    }, delay);
    this.maintenanceTimer.unref();
  }
  maintain(overrides: Partial<StoragePolicy> = {}, now = Date.now()): Promise<MaintenanceReport> {
    const existing = maintenance.get(this.root); if (existing) return existing;
    const policy = storagePolicy({ ...this.options.policy, ...this.effectivePolicy, ...overrides }); this.effectivePolicy = policy;
    const task = this.performMaintenance(policy, now);
    maintenance.set(this.root, task);
    void task.finally(() => { if (maintenance.get(this.root) === task) maintenance.delete(this.root); }).catch(() => {});
    return task;
  }
  private publishBase(base: RetentionBase) {
    const directory = path.dirname(this.file), encoded = JSON.stringify(base);
    writeSnapshot(path.join(directory, "retention.json"), encoded);
    writeSnapshot(path.join(directory, "retention.backup.json"), encoded);
    for (const name of ["retention.json", "retention.backup.json"]) {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")); const { digest: actual, ...body } = value;
      if (actual !== base.digest || digest(body) !== actual) throw new Error("Retention baseline publication failed; original logs were preserved");
    }
  }
  private async removeRetired(report: MaintenanceReport) {
    const through = this.base?.state.seq ?? 0;
    if (!through) return;
    const names = await fs.promises.readdir(this.segmentDirectory).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
    // The retention baseline is already published: a new backup cannot capture
    // retired sources. Read existing pins once rather than once per segment.
    const pinned = new Set<string>(), pins = path.join(path.dirname(this.file), "backup-pins");
    for (const pin of await fs.promises.readdir(pins).catch((e) => { if (e.code === "ENOENT") return []; throw e; })) {
      if (!/^[a-f0-9-]{36}\.json$/.test(pin)) continue;
      try {
        const payload = JSON.parse(await fs.promises.readFile(path.join(pins, pin), "utf8"));
        let alive = true; try { process.kill(payload.pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; else throw e; }
        if (!alive) { await unlinkManaged(this.root, path.join(pins, pin)); continue; }
        for (const name of payload.files) pinned.add(name);
      } catch (error: any) {
        if (error.code !== "ENOENT") { report.errors.push(`backup pin: ${String(error)}`); return; }
      }
    }
    for (const name of names) {
      const match = segmentPattern.exec(name); if (!match || Number(match[2]) > through) continue;
      const file = path.join(this.segmentDirectory, name);
      try {
        if (pinned.has(`segments/${name}`)) continue;
        const size = (await fs.promises.stat(file)).size; await unlinkManaged(this.root, file); report.deletedLogBytes += size;
      }
      catch (error) { report.errors.push(`retired segment ${name}: ${String(error)}`); }
    }
  }
  private async performMaintenance(policy: StoragePolicy, now: number): Promise<MaintenanceReport> {
    const report: MaintenanceReport = { compactedSegments: 0, deletedLogBytes: 0, archiveBytes: 0, indexBytes: 0, logBytes: 0, totalBytes: 0, overQuota: false, completedProcesses: 0, errors: [] };
    const directory = path.dirname(this.file);
    const initialBytes = await directoryBytes(directory);
    const captured = this.locked(() => {
      // A small quota can also seal the active file. Pending inputs and tools
      // are captured in the base; sealing does not finish or replay them.
      if (this.offset && (this.offset + this.segments.reduce((n, s) => n + s.size, 0) > policy.maxLogBytes || initialBytes > policy.maxTotalBytes)) this.rotate(true);
      return { base: this.base ? structuredClone(this.base) : undefined, segments: this.segments.slice(), activeBytes: this.offset };
    });
    let remaining = captured.activeBytes + captured.segments.reduce((n, s) => n + s.size, 0);
    const selected: Segment[] = [];
    for (const segment of captured.segments) {
      if (remaining <= policy.maxLogBytes && now - segment.mtimeMs < policy.retentionMs && initialBytes <= policy.maxTotalBytes) break;
      selected.push(segment); remaining -= segment.size;
    }
    if (selected.length) {
      const prefix = captured.base ? structuredClone(captured.base.state) : empty();
      const archives = captured.base?.archives.slice() ?? [];
      for (const segment of selected) {
        const bytes = await fs.promises.readFile(path.join(this.segmentDirectory, segment.name));
        if (bytes.length !== segment.size || bytes.at(-1) !== 10) throw new Error("Sealed segment changed during retention prepare");
        const entries = parseEvents(bytes), memory: Entry[] = [];
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!, { hash: actual, ...body } = e;
          if (e.seq !== prefix.seq + 1 || hash(body, prefix.lastHash) !== actual) throw new Error("Retention refused an unverified history prefix");
          reduce(prefix, e); if (isMemoryEvent(e)) memory.push(e);
          if (i % 32 === 0) await yieldIO();
        }
        const match = segmentPattern.exec(segment.name)!;
        if (prefix.seq !== Number(match[2])) throw new Error("Retention segment boundary mismatch");
        const body = { version: 1 as const, from: Number(match[1]), to: Number(match[2]), lastHash: prefix.lastHash, entries: memory };
        const value = { ...body, digest: digest(body) }, compressed = await zip(Buffer.from(JSON.stringify(value)));
        const ref: ArchiveRef = { name: segment.name.replace(".jsonl", ".mem.gz"), from: body.from, to: body.to, lastHash: body.lastHash, digest: value.digest, bytes: compressed.length, events: memory.length };
        const archiveFile = path.join(directory, "memory", ref.name);
        await writeBuffer(archiveFile, compressed);
        await decodeArchive(await fs.promises.readFile(archiveFile), ref); // Verify persisted evidence before permitting source deletion.
        archives.push(ref); report.archiveBytes += compressed.length;
      }
      const body = { version: 1 as const, generation: (captured.base?.generation ?? 0) + 1, state: prefix, archives };
      const base: RetentionBase = { ...body, digest: digest(body) };
      this.locked(() => {
        if ((this.base?.generation ?? 0) !== (captured.base?.generation ?? 0) || JSON.stringify(this.segments.slice(0, selected.length)) !== JSON.stringify(selected)) throw new Error("History changed during retention prepare; retry maintenance");
        this.publishBase(base);
        this.initialized = false; this.refresh();
      });
      report.compactedSegments = selected.length;
    }
    // Repair an interrupted two-copy publication before deleting leftovers from
    // a previous crash. Deletion itself is idempotent and never touches archives.
    this.locked(() => { if (this.base) this.publishBase(this.base); });
    let backupReady = true;
    if (this.state.seq) try { report.backup = await this.backup(); }
    catch (error) { backupReady = false; report.errors.push(`backup failed; original logs retained: ${String(error)}`); }
    if (backupReady) await this.removeRetired(report);
    await cleanAbandonedDrafts(this.root, directory, now, policy.retentionMs);
    this.refresh();
    const index = new HistoryIndex(path.join(directory, "index"), this.root, policy.maxTotalBytes);
    const sources = this.locked(() => this.sources(), false);
    // Index maintenance is bounded per run and yields between sources. Queries
    // build any missing source on demand; rebuilding never blocks conversation.
    for (const source of (await index.uncovered(sources.filter((s) => s.persistent))).slice(-64)) {
      await this.withSource(source, async (actual, read) => {
        await index.candidates(actual, "", [], read, { sourcesVisited: 0, indexHits: 0, candidateEvents: 0, bytesRead: 0, rebuilt: 0 }, policy.maxIndexBytes);
      });
      await yieldIO();
    }
    await index.flushCatalog(policy.maxIndexBytes, new Set(sources.filter((s) => s.persistent).map((s) => s.key)));
    const withoutIndex = await directoryBytes(directory) - await directoryBytes(path.join(directory, "index"));
    report.indexBytes = await index.trim(Math.min(policy.maxIndexBytes, Math.max(0, policy.maxTotalBytes - withoutIndex - 2048)), new Set(sources.filter((s) => s.persistent).map((s) => s.key)));
    try { report.completedProcesses = await cleanCompletedProcesses(this.root, policy, now); }
    catch (error) { report.errors.push(`completed processes: ${String(error)}`); }
    this.refresh();
    report.logBytes = (await fs.promises.stat(this.file).catch((e) => { if (e.code === "ENOENT") return undefined; throw e; }))?.size ?? 0;
    report.logBytes += await directoryBytes(this.segmentDirectory); // Includes failed-to-delete retired files, not just logical live segments.
    if (await directoryBytes(directory) > policy.maxTotalBytes) {
      for (const name of ["current.json", "checkpoint.json"]) await unlinkManaged(this.root, path.join(directory, name)); // Disposable projections only.
    }
    report.totalBytes = await directoryBytes(directory);
    report.overQuota = report.logBytes > policy.maxLogBytes || report.totalBytes > policy.maxTotalBytes;
    this.lastMaintenance = report;
    const statusFile = path.join(directory, "storage-status.json");
    const previous = await fs.promises.stat(statusFile).catch(() => undefined);
    const fixedBytes = report.totalBytes - (previous?.size ?? 0);
    for (let i = 0; i < 3; i++) {
      report.totalBytes = fixedBytes + Buffer.byteLength(JSON.stringify({ updatedAt: now, policy, ...report }));
      report.overQuota = report.logBytes > policy.maxLogBytes || report.totalBytes > policy.maxTotalBytes;
    }
    await writeBuffer(statusFile, Buffer.from(JSON.stringify({ updatedAt: now, policy, ...report })));
    if (report.overQuota) process.stderr.write("[storage] quota pressure: protected memory/recovery state was retained; inspect storage-status.json\n");
    return report;
  }
  private makeSource(file: string, key: string, from: number, to: number, archive?: ArchiveRef, persistent = true): Source {
    if (archive) return { file, key, from, to, archive, size: archive.bytes, persistent, fingerprint: `${key}:${archive.bytes}:${archive.digest}` };
    const s = fs.statSync(file);
    return { file, key, from, to, archive, size: s.size, persistent, fingerprint: `${key}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:` };
  }
  private sources(): Source[] {
    const sources = (this.base?.archives ?? []).map((a) => this.makeSource(path.join(path.dirname(this.file), "memory", a.name), `m-${a.name}`, a.from, a.to, a));
    for (const segment of this.segments) {
      const match = segmentPattern.exec(segment.name)!;
      sources.push(this.makeSource(path.join(this.segmentDirectory, segment.name), `s-${segment.name}`, Number(match[1]), Number(match[2])));
    }
    if (this.offset) sources.push(this.makeSource(this.file, "active", this.segmentStart, this.state.seq, undefined, false));
    return sources;
  }
  private sourceFor(request: Source): Source | undefined {
    const a = this.base?.archives.find((s) => s.from <= request.from && s.to >= request.to);
    if (a) return this.makeSource(path.join(path.dirname(this.file), "memory", a.name), `m-${a.name}`, a.from, a.to, a);
    for (const segment of this.segments) {
      const match = segmentPattern.exec(segment.name)!;
      if (Number(match[1]) <= request.from && Number(match[2]) >= request.to) return this.makeSource(path.join(this.segmentDirectory, segment.name), `s-${segment.name}`, Number(match[1]), Number(match[2]));
    }
    if (this.offset && this.segmentStart <= request.from && this.state.seq >= request.to) return this.makeSource(this.file, "active", this.segmentStart, this.state.seq, undefined, false);
  }
  private async withSource<T>(request: Source, use: (source: Source, read: () => Promise<Entry[]>) => Promise<T>, stats?: SearchStats): Promise<T> {
    const opened = this.locked(() => {
      const source = this.sourceFor(request);
      if (!source) throw new Error("Retained history source disappeared; refusing an incomplete recall");
      return { source, fd: fs.openSync(source.file, "r") };
    }, false);
    let entries: Entry[] | undefined;
    const read = async () => {
      if (entries) return entries;
      const bytes = Buffer.alloc(opened.source.size); let offset = 0;
      while (offset < bytes.length) {
        const count = await new Promise<number>((resolve, reject) => fs.read(opened.fd, bytes, offset, bytes.length - offset, offset, (error, n) => error ? reject(error) : resolve(n)));
        if (!count) throw new Error("History source was truncated during recall"); offset += count;
      }
      if (stats) stats.bytesRead += bytes.length;
      entries = opened.source.archive ? (await decodeArchive(bytes, opened.source.archive)).entries : parseEvents(bytes);
      return entries;
    };
    try { return await use(opened.source, read); } finally { fs.closeSync(opened.fd); }
  }
  async search(conversation: string, query: string, limit = 10, options: { useIndex?: boolean } = {}) {
    const snapshot = this.locked(() => ({ through: this.state.seq, sources: this.sources() }), false);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean), through = snapshot.through;
    const found: Array<{ seq: number; agent: string; revision: number; kind: string; excerpt: string }> = [];
    const stats = { sourcesVisited: 0, indexHits: 0, candidateEvents: 0, bytesRead: 0, rebuilt: 0 }; this.lastSearch = stats;
    const policy = this.effectivePolicy ?? storagePolicy(this.options.policy);
    const index = new HistoryIndex(path.join(path.dirname(this.file), "index"), this.root, policy.maxTotalBytes);
    const max = Number.isFinite(limit) ? Math.min(20, Math.max(1, Math.floor(limit))) : 10;
    const planned = options.useIndex === false ? snapshot.sources : await index.plan(snapshot.sources, conversation, terms, stats);
    for (const request of planned.reverse()) {
      stats.sourcesVisited++;
      await this.withSource(request, async (source, read) => {
        const candidates = options.useIndex === false ? (await read()).slice().reverse() : await index.candidates(source, conversation, terms, read, stats, policy.maxIndexBytes, true);
        for (const e of candidates) {
          if (e.seq > through || e.conversation !== conversation) continue;
          const data = JSON.stringify(e.data), lower = data.toLowerCase();
          if (!terms.every((term) => lower.includes(term))) continue;
          const hit = Math.max(0, lower.indexOf(terms[0] ?? "") - 100);
          found.push({ seq: e.seq, agent: e.agent, revision: e.revision, kind: e.kind, excerpt: data.slice(hit, hit + 1600) });
          if (found.length === max) break;
        }
      }, stats);
      if (found.length === max) break;
    }
    return found.reverse();
  }
}

function reduce(p: Projection, e: Entry) {
  reduceBudget(p, e);
  p.seq = e.seq; p.lastHash = e.hash;
  if (e.kind === "inbox.received") p.inbox[e.data.id] = { ...e.data, conversation: e.conversation, agent: e.agent };
  if (e.kind === "inbox.dispatched") delete p.inbox[e.data.id];
  const s = p.conversations[e.conversation] ??= {
    id: e.conversation, revision: 0, goal: "", constraints: [], updatedAt: e.ts,
    todos: [], decisions: [], facts: [], tools: {}, inputs: [],
  };
  s.updatedAt = e.ts;
  if (e.kind === "agent.bound") {
    p.agents[e.agent] = { ...e.data, conversation: e.conversation, revision: e.revision, status: "running" };
    if (!s.goal && !e.data.parent) s.goal = e.data.goal ?? "";
  }
  if (e.kind === "requirement.changed") {
    s.revision = e.revision; s.goal = e.data.text; s.todos = []; s.decisions = [];
    for (const a of Object.values(p.agents)) if (a.conversation === e.conversation) {
      if (a.parent && (a.status === "running" || a.status === "interrupted")) { a.status = "superseded"; a.outcome = { seq: e.seq, reason: "requirement-superseded", summary: a.outcome?.summary ?? "", evidence: a.outcome?.evidence ?? [], remaining: (a.todos ?? []).filter((t) => t.state !== "done").map((t) => t.text), artifacts: a.outcome?.artifacts ?? [], lastError: a.lastError }; }
      else if (!a.parent) { a.revision = e.revision; a.status = "running"; a.goal = s.goal; }
    }
    for (const tool of Object.values(s.tools)) if (tool.status === "pending") tool.status = "uncertain";
    for (const input of s.inputs) if (input.status !== "done") input.status = "superseded";
  }
  if (e.kind === "session.recovered") {
    for (const task of Object.values(s.work ?? {})) for (const op of Object.values(task.operations)) if (op.status === "pending") op.status = "uncertain";
    for (const tool of Object.values(s.tools)) if (tool.status === "pending") tool.status = "uncertain";
    for (const a of Object.values(p.agents)) if (a.conversation === e.conversation && a.parent && a.status === "running") { a.status = "interrupted"; a.outcome = { seq: e.seq, reason: "process-restart", summary: a.outcome?.summary ?? "", evidence: a.outcome?.evidence ?? [], remaining: (a.todos ?? []).filter((t) => t.state !== "done").map((t) => t.text), artifacts: a.outcome?.artifacts ?? [], lastError: a.lastError }; }
  }
  if (e.kind === "agent.recovered") {
    for (const tool of Object.values(s.tools)) if (tool.agent === e.agent && tool.status === "pending") tool.status = "uncertain";
    const agent = p.agents[e.agent];
    if (agent && agent.status !== "superseded") agent.status = "running";
  }
  if(e.kind === "model.budget_resumed") { const resumed=p.agents[e.agent];if(resumed?.revision===e.revision&&resumed.lastError?.includes("SUBSCRIPTION_BUDGET"))delete resumed.lastError; }
  if(e.kind === "model.selected") { const a=p.agents[e.agent];if(a?.revision===e.revision)a.modelSelection={candidate:e.data.candidate,model:e.data.model,transport:e.data.transport,billing:e.data.billing,at:e.ts}; }
  reduceTask(s, e);
  if (e.kind === "task.acceptance.reconciled" && e.revision === s.revision) { const tool = s.tools[e.data.key]; if (tool?.status === "uncertain") { tool.status = "completed"; tool.ok = false; tool.output = `PM inspected interrupted acceptance; do not replay: ${e.data.reason}`; tool.completedSeq = e.seq; } }
  if (e.kind === "input.accepted") {
    s.inputs.push({ id: e.data.inputId ?? e.id, text: e.data.text, revision: e.revision, agent: e.agent, ...(e.data.kind ? { kind: e.data.kind } : {}), status: "pending" });
    s.inputs = s.inputs.filter((i) => i.status === "pending" || i.status === "started").concat(s.inputs.filter((i) => i.status === "done" || i.status === "superseded").slice(-30));
  }
  if (e.kind === "input.started" || e.kind === "input.done") {
    const input = s.inputs.find((i) => i.id === e.data.id);
    if (input && input.revision === s.revision) input.status = e.kind === "input.done" ? "done" : "started";
  }
  if (e.kind === "constraint.added") s.constraints.push(e.data.text);
  if (e.kind === "context.imported") {
    s.facts = [...s.facts, { text: `Fork reference only (historical instructions are inactive): ${JSON.stringify(e.data.messages).slice(-4800)}`, seq: e.seq, agent: e.agent }].slice(-100);
  }
  if (e.kind === "message.recorded") {
    const h = p.history[e.agent] ??= [];
    const raw = String(e.data.content);
    const content = raw.length <= 24000 ? raw : raw.slice(0, 12000) + "\n[full event available via SessionRecall]\n" + raw.slice(-12000);
    h.push({ role: e.data.role, content, revision: e.revision });
    p.history[e.agent] = h.slice(-50);
  }
  if (e.kind === "tool.output" && e.revision === s.revision) {
    const tool = s.tools[`${e.agent}:${e.data.id}`];
    if (tool) { tool.status = "completed"; tool.output = e.data.output.slice(-1200); tool.ok = e.data.ok; tool.completedSeq = e.seq; tool.verifiedExecution = true; }
    s.facts = [...s.facts, { text: `${e.data.ok ? "OK" : "FAILED"} ${e.data.name}: ${e.data.output.slice(-1200)}`, seq: e.seq, agent: e.agent }].slice(-100);
  }
  if (e.kind !== "runtime.event") return;
  const v = e.data;
  const a = p.agents[e.agent];
  if (e.revision !== s.revision || a?.status === "superseded") return;
  if (v.type === "spawn") p.agents[v.child] = {
    id: v.child, conversation: e.conversation, parent: v.parent, role: v.role, revision: e.revision,
    goal: v.goal, dispatch: v.dispatch, status: "running", workId: Object.values(s.work ?? {}).find((t) => t.latestAgent === v.child && t.revision === e.revision)?.id,
  };
  if (v.type === "todo.set" && !a?.parent) s.todos = v.items;
  if (v.type === "todo.set" && a?.parent) a.todos = v.items;
  if (v.type === "decision.record") s.decisions = [...s.decisions, { text: v.decision, seq: e.seq }].slice(-100);
  if (v.type === "tool.call") {
    const key = `${e.agent}:${v.id}`, previous = s.tools[key];
    if (previous && previous.revision !== e.revision && previous.status !== "completed") s.tools[`${key}@${previous.revision}`] = previous;
    if (!previous || previous.revision !== e.revision) s.tools[key] = { name: v.name, args: v.args, agent: e.agent, revision: e.revision, status: "pending", verifiedExecution: false };
  }
  if (v.type === "tool.result") {
    const tool = s.tools[`${e.agent}:${v.id}`];
    if (tool && tool.status === "pending") { tool.status = "completed"; tool.output = v.output.slice(-1200); tool.ok = v.ok; tool.completedSeq = e.seq; }
    s.facts = [...s.facts, { text: `${v.ok ? "OK" : "FAILED"} ${v.output.slice(-1200)}`, seq: e.seq, agent: e.agent }].slice(-100);
    const completed = Object.keys(s.tools).filter((id) => s.tools[id]!.status === "completed");
    for (const id of completed.slice(0, -30)) delete s.tools[id];
  }
  if (v.type === "unit.handup" && a) a.outcome = { seq: e.seq, reason: "handup", summary: String(v.summary ?? "").slice(0, 4000), evidence: a.outcome?.evidence ?? [], remaining: (v.failed_acceptance ?? []).slice(0, 20), artifacts: (v.artifacts ?? []).slice(0, 20), lastError: a.lastError };
  if (v.type === "agent.done" && a) {
    a.status = v.success ? "done" : "failed";
    a.outcome = { seq: e.seq, reason: String(v.reason ?? (v.success ? "reported-complete" : "stopped-without-reason")).slice(0, 2000), summary: a.outcome?.summary ?? "", evidence: (v.evidence ?? []).slice(0, 20).map((s: string) => String(s).slice(0, 1000)), remaining: a.outcome?.remaining.length ? a.outcome.remaining : (a.todos ?? []).filter((t) => t.state !== "done").map((t) => t.text), artifacts: a.outcome?.artifacts ?? [], lastError: a.lastError, reportedSuccess: !!v.success };
    for (const tool of Object.values(s.tools)) if (tool.agent === a.id && tool.status === "pending") tool.status = "uncertain";
  }
  if (v.type === "agent.error" && a) {
    a.lastError = `${v.code}: ${v.detail ?? ""}`.slice(0, 2000);
    if (v.code === "http_error" || v.code === "context_error") a.status = "failed";
  }
}

const journals = new Map<string, SessionJournal>();
export function sessionJournal(root = process.cwd()): SessionJournal {
  let journal = journals.get(root);
  if (!journal) { journal = new SessionJournal(root, { automatic: true }); journals.set(root, journal); }
  return journal;
}
