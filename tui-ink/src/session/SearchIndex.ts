import fs from "node:fs";
import path from "node:path";
import type { Entry } from "./Journal.js";
import { digest, unzip, zip, writeBuffer, yieldIO, unlinkManaged, directoryBytes } from "./Storage.js";

export interface SearchSource { key: string; from: number; to: number; fingerprint: string; persistent: boolean }
interface Row { ordinal: number; conversation: string; bloom: string }
interface Index { version: 1 | 2; fingerprint: string; rows: Row[]; digest: string; summary?: string; conversations?: string[] }
interface Hint { fingerprint: string; summary: string; conversations: string[] }
interface CatalogState { stamp: string; hints: Map<string, Hint>; dirty: boolean }
const catalogs = new Map<string, CatalogState>();
const indexing = new Set<Promise<unknown>>();
const indexingByRoot = new Map<string, number>();
export async function waitForIndexing() { await Promise.allSettled([...indexing]); }
export interface SearchStats { sourcesVisited: number; indexHits: number; candidateEvents: number; bytesRead: number; rebuilt: number; indexBytesRead?: number; catalogSkipped?: number; catalogBytesRead?: number; fallbackSources?: number; rebuildQueued?: number }
const positions = (a: number, b: number, c: number, mask = 2047): [number, number] => {
  const n = Math.imul(a ^ 2166136261, 16777619) ^ Math.imul(b, 31) ^ c;
  return [n & mask, ((n >>> 11) ^ Math.imul(n, 97)) & mask];
};
const cacheWrites = new Map<string, Promise<unknown>>();
async function bloom(text: string, summary?: Buffer) {
  const bits = Buffer.alloc(256);
  for (let i = 0; i + 2 < text.length; i++) {
    const [a, b] = positions(text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2));
    bits[a >>> 3] |= 1 << (a & 7); bits[b >>> 3] |= 1 << (b & 7);
    if (summary) {
      const [x, y] = positions(text.charCodeAt(i), text.charCodeAt(i + 1), text.charCodeAt(i + 2), summary.length * 8 - 1);
      summary[x >>> 3] |= 1 << (x & 7); summary[y >>> 3] |= 1 << (y & 7);
    }
    if (i && i % 16384 === 0) await yieldIO();
  }
  return bits.toString("base64");
}
function possible(encoded: string, terms: string[]) {
  const bits = Buffer.from(encoded, "base64");
  if (bits.length !== 256 && bits.length !== 8192) throw new Error("Invalid search index filter");
  for (const term of terms) for (let i = 0; i + 2 < term.length; i++) {
    const [a, b] = positions(term.charCodeAt(i), term.charCodeAt(i + 1), term.charCodeAt(i + 2), bits.length * 8 - 1);
    if (!(bits[a >>> 3] & (1 << (a & 7))) || !(bits[b >>> 3] & (1 << (b & 7)))) return false;
  }
  return true;
}

/** Rebuildable per-source trigram Bloom index. False positives are checked against
 * original event text; short terms intentionally fall back to candidate scanning. */
export class HistoryIndex {
  constructor(private directory: string, private root = path.resolve(directory, "../../.."), private totalBudget = Infinity) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = (cacheWrites.get(this.directory) ?? Promise.resolve()).catch(() => {}).then(work);
    cacheWrites.set(this.directory, task); void task.finally(() => { if (cacheWrites.get(this.directory) === task) cacheWrites.delete(this.directory); }).catch(() => {});
    return task;
  }
  private async files() {
    const names = await fs.promises.readdir(this.directory).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
    const rows: Array<{ name: string; bytes: number; time: number }> = [];
    for (const name of names.filter((n) => n === "catalog.json.gz" || /^[sm]-[\d.-]+(?:jsonl|mem\.gz)\.idx\.gz$/.test(n))) {
      try { const s = await fs.promises.lstat(path.join(this.directory, name)); if (s.isFile() && !s.isSymbolicLink()) rows.push({ name, bytes: s.size, time: s.mtimeMs }); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
    }
    return rows.sort((a, b) => a.time - b.time);
  }
  trim(maxBytes: number, liveKeys?: Set<string>) {
    return this.serial(async () => {
      const files = await this.files(); let total = files.reduce((n, f) => n + f.bytes, 0);
      for (const file of files) if ((liveKeys && file.name !== "catalog.json.gz" && !liveKeys.has(file.name.slice(0, -7))) || total > maxBytes) {
        await unlinkManaged(this.root, path.join(this.directory, file.name)); total -= file.bytes;
      }
      return total;
    });
  }
  private async catalog(stats?: SearchStats) {
    const file = path.join(this.directory, "catalog.json.gz");
    const s = await fs.promises.stat(file).catch(() => undefined), stamp = s ? `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "";
    const cached = catalogs.get(this.directory); if (cached && (cached.dirty || cached.stamp === stamp)) return cached;
    const state: CatalogState = { stamp, hints: new Map(), dirty: false };
    if (s) try {
      const bytes = await fs.promises.readFile(file); if (stats) stats.catalogBytesRead = (stats.catalogBytesRead ?? 0) + bytes.length;
      const value = JSON.parse((await unzip(bytes)).toString("utf8")), { digest: actual, ...body } = value;
      if (value.version !== 1 || digest(body) !== actual || !Array.isArray(value.hints)) throw new Error("Invalid catalog");
      for (const [key, hint] of value.hints as Array<[string, Hint]>) {
        if (typeof key !== "string" || typeof hint.fingerprint !== "string" || !Array.isArray(hint.conversations) || ![256, 8192].includes(Buffer.from(hint.summary, "base64").length)) throw new Error("Invalid catalog hint");
        state.hints.set(key, hint);
      }
    } catch { state.hints.clear(); }
    catalogs.set(this.directory, state);
    if (catalogs.size > 16) { const key = catalogs.keys().next().value; if (key !== undefined && key !== this.directory) catalogs.delete(key); }
    return state;
  }
  async plan<T extends SearchSource>(sources: T[], conversation: string, terms: string[], stats: SearchStats): Promise<T[]> {
    const state = await this.catalog(stats), result: T[] = [];
    for (const source of sources) {
      const hint = state.hints.get(source.key);
      if (source.persistent && hint?.fingerprint === source.fingerprint && (!hint.conversations.includes(conversation) || !possible(hint.summary, terms))) { stats.catalogSkipped = (stats.catalogSkipped ?? 0) + 1; continue; }
      result.push(source);
    }
    return result;
  }
  async uncovered<T extends SearchSource>(sources: T[]) {
    const state = await this.catalog(); return sources.filter((s) => state.hints.get(s.key)?.fingerprint !== s.fingerprint);
  }
  private async remember(source: SearchSource, index: Index) {
    const state = await this.catalog(); let summary = index.summary;
    if (!summary) {
      const bits = Buffer.alloc(256); for (const row of index.rows) { const b = Buffer.from(row.bloom, "base64"); for (let i = 0; i < bits.length; i++) bits[i] |= b[i]!; } summary = bits.toString("base64");
    }
    state.hints.set(source.key, { fingerprint: source.fingerprint, summary, conversations: index.conversations ?? [...new Set(index.rows.map((r) => r.conversation))] }); state.dirty = true;
  }
  async flushCatalog(maxBytes: number, liveKeys?: Set<string>) {
    const state = await this.catalog();
    if (liveKeys) for (const key of state.hints.keys()) if (!liveKeys.has(key)) { state.hints.delete(key); state.dirty = true; }
    if (!state.dirty || !maxBytes || !fs.existsSync(this.root)) return;
    const body = { version: 1, hints: [...state.hints] }, encoded = await zip(Buffer.from(JSON.stringify({ ...body, digest: digest(body) })));
    await this.persist(path.join(this.directory, "catalog.json.gz"), encoded, maxBytes);
    state.dirty = false; const s = await fs.promises.stat(path.join(this.directory, "catalog.json.gz")).catch(() => undefined); state.stamp = s ? `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "";
  }
  private async persist(file: string, bytes: Buffer, maxBytes: number) {
    if (bytes.length > maxBytes || !fs.existsSync(this.root)) return;
    await this.serial(async () => {
      const files = await this.files(), cacheBytes = files.reduce((n, f) => n + f.bytes, 0);
      const outsideCache = Number.isFinite(this.totalBudget) ? await directoryBytes(path.dirname(this.directory)) - cacheBytes : 0;
      const budget = Math.min(maxBytes, Math.max(0, this.totalBudget - outsideCache - 2048));
      if (bytes.length > budget) { let total = cacheBytes; for (const old of files) if (total > budget) { await unlinkManaged(this.root, path.join(this.directory, old.name)); total -= old.bytes; } return; }
      let total = files.filter((f) => f.name !== path.basename(file)).reduce((n, f) => n + f.bytes, 0);
      for (const old of files) if (old.name !== path.basename(file) && total + bytes.length > budget) { await unlinkManaged(this.root, path.join(this.directory, old.name)); total -= old.bytes; }
      await writeBuffer(file, bytes);
    }).catch(() => {});
  }
  private async build(source: SearchSource, entries: Entry[], maxBytes: number) {
    const rows: Row[] = [], summary = Buffer.alloc(8192);
    for (let i = 0; i < entries.length; i++) { const event = entries[i]!; rows.push({ ordinal: i, conversation: event.conversation, bloom: await bloom(JSON.stringify(event.data).toLowerCase(), summary) }); if (i % 32 === 0) await yieldIO(); }
    const body = { version: 2 as const, fingerprint: source.fingerprint, rows, summary: summary.toString("base64"), conversations: [...new Set(rows.map((r) => r.conversation))] };
    const index = { ...body, digest: digest(body) }; await this.remember(source, index);
    if (source.persistent && maxBytes) await this.persist(path.join(this.directory, `${source.key}.idx.gz`), await zip(Buffer.from(JSON.stringify(index))), maxBytes);
    return index;
  }
  async candidates(source: SearchSource, conversation: string, terms: string[], read: () => Promise<Entry[]>, stats: SearchStats, maxBytes: number, deferBuild = false) {
    let index: Index | undefined, entries: Entry[] | undefined;
    const file = path.join(this.directory, `${source.key}.idx.gz`);
    if (source.persistent) try {
      const compressed = await fs.promises.readFile(file); stats.indexBytesRead = (stats.indexBytesRead ?? 0) + compressed.length;
      const value = JSON.parse((await unzip(compressed)).toString("utf8")) as Index;
      const { digest: actual, ...body } = value;
      if ((value.version === 1 || value.version === 2) && value.fingerprint === source.fingerprint && digest(body) === actual && value.rows.every((r) => Buffer.from(r.bloom, "base64").length === 256)) { index = value; stats.indexHits++; }
    } catch { /* Missing, stale or corrupt index: the source remains authoritative. */ }
    if (!index) {
      if (deferBuild || !source.persistent) {
        entries = await read(); stats.fallbackSources = (stats.fallbackSources ?? 0) + 1;
        if (source.persistent && (indexingByRoot.get(this.root) ?? 0) < 2) {
          indexingByRoot.set(this.root, (indexingByRoot.get(this.root) ?? 0) + 1);
          const task = this.build(source, entries, maxBytes).then(() => this.flushCatalog(maxBytes)).catch(() => {}).finally(() => { indexing.delete(task); indexingByRoot.set(this.root, (indexingByRoot.get(this.root) ?? 1) - 1); });
          indexing.add(task); stats.rebuildQueued = (stats.rebuildQueued ?? 0) + 1;
        }
        stats.candidateEvents += entries.length; return entries.slice().reverse();
      }
      entries = await read(); index = await this.build(source, entries, maxBytes); stats.rebuilt++;
    }
    if (source.persistent) await this.remember(source, index);
    const ordinals = index.rows.filter((r) => r.conversation === conversation && possible(r.bloom, terms)).map((r) => r.ordinal).reverse();
    stats.candidateEvents += ordinals.length;
    if (!ordinals.length) return [];
    entries ??= await read();
    return ordinals.map((n) => entries![n]).filter((e): e is Entry => !!e);
  }
}
