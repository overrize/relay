import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import type { Entry, Projection } from "./Journal.js";

export const zip = promisify(gzip), unzip = promisify(gunzip);
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const yieldIO = () => new Promise<void>((resolve) => setImmediate(resolve));
export interface ArchiveRef { name: string; from: number; to: number; lastHash: string; digest: string; bytes: number; events: number }
export interface RetentionBase { version: 1; generation: number; state: Projection; archives: ArchiveRef[]; digest: string }
export interface MemoryArchive { version: 1; from: number; to: number; lastHash: string; entries: Entry[]; digest: string }
export interface StoragePolicy {
  maxLogBytes: number; retentionMs: number; maxIndexBytes: number;
  maxTotalBytes: number; processRetentionMs: number; maxCompletedProcessBytes: number;
}
function setting(name: string, fallback: number) {
  const raw = process.env[name]; if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return value;
}
export function storagePolicy(overrides: Partial<StoragePolicy> = {}): StoragePolicy {
  const policy = {
    maxLogBytes: setting("SPAWN_LOG_MAX_BYTES", 64 * 1024 * 1024),
    retentionMs: setting("SPAWN_LOG_RETENTION_MS", 30 * 86400000),
    maxIndexBytes: setting("SPAWN_INDEX_MAX_BYTES", 32 * 1024 * 1024),
    maxTotalBytes: setting("SPAWN_STORAGE_MAX_BYTES", 256 * 1024 * 1024),
    processRetentionMs: setting("SPAWN_PROCESS_RETENTION_MS", 7 * 86400000),
    maxCompletedProcessBytes: setting("SPAWN_PROCESS_MAX_BYTES", 8 * 1024 * 1024),
    ...overrides,
  };
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative integer`);
  return policy;
}
export async function writeBuffer(file: string, content: Buffer) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, "wx", 0o600); await handle.writeFile(content); await handle.sync();
    await handle.close(); handle = undefined; await fs.promises.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.promises.unlink(temporary).catch((e) => { if (e.code !== "ENOENT") throw e; });
  }
}
export function loadRetention(directory: string,onArchiveStat?:(file:string,stat:fs.Stats)=>void): RetentionBase | undefined {
  const valid: RetentionBase[] = [],checkedSizes=new Map<string,number>(); let existed = false;
  for (const name of ["retention.json", "retention.backup.json"]) {
    try {
      const file = path.join(directory, name); if (!fs.existsSync(file)) continue;
      existed = true; const value = JSON.parse(fs.readFileSync(file, "utf8")) as RetentionBase;
      const { digest: actual, ...body } = value;
      if (value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.archives) || !value.state || digest(body) !== actual) continue;
      const refs = value.archives; let next = 1;
      for (const ref of refs) {
        if (!/^\d{16}-\d{16}\.mem\.gz$/.test(ref.name) || ref.from !== next || ref.to < next) throw new Error("Invalid memory archive sequence");
        next = ref.to + 1;
        const archive=path.join(directory,'memory',ref.name);let size=checkedSizes.get(archive);if(size===undefined){const stat=fs.statSync(archive);size=stat.size;checkedSizes.set(archive,size);onArchiveStat?.(archive,stat);}
        if (size !== ref.bytes) throw new Error("Missing or incomplete memory archive");
      }
      if (next !== value.state.seq + 1 || refs.at(-1)?.lastHash !== value.state.lastHash) continue;
      valid.push(value);
    } catch { /* The independently written second copy may still be valid. */ }
  }
  if (valid.length) return valid.sort((a, b) => b.generation - a.generation)[0];
  if (existed) throw new Error("Both retention baselines are invalid; refusing to reset retained memory");
  const memory = path.join(directory, "memory");
  if (fs.existsSync(memory) && fs.readdirSync(memory).some((n) => n.endsWith(".mem.gz"))) {
    // An interrupted prepare may leave archives before the first baseline was
    // published. Original logs starting at 1 are still a complete source.
    const segments = path.join(directory, "segments");
    const firstSegment = fs.existsSync(segments) && fs.readdirSync(segments).some((n) => /^0000000000000001-\d{16}\.jsonl$/.test(n));
    let firstActive = false;
    try { firstActive = JSON.parse(fs.readFileSync(path.join(directory, "journal.jsonl"), "utf8").split("\n")[0]!).seq === 1; } catch { /* no original prefix */ }
    if (!firstSegment && !firstActive) throw new Error("Memory archives exist without a recovery baseline; inspect before execution");
  }
  return undefined;
}
export async function unlinkManaged(root: string, file: string): Promise<void> {
  try {
    const absoluteRoot = await fs.promises.realpath(root), parent = await fs.promises.realpath(path.dirname(file));
    if (!parent.startsWith(absoluteRoot + path.sep)) throw new Error("Refusing cleanup outside the workspace");
    const entry = await fs.promises.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Refusing cleanup of a linked or unexpected entry");
    await fs.promises.unlink(file);
  } catch (e: any) { if (e.code !== "ENOENT") throw e; }
}
export function parseEvents(bytes: Buffer): Entry[] {
  const end = bytes.lastIndexOf(10) + 1;
  return bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry);
}
export function isMemoryEvent(e: Entry): boolean {
  if (e.kind === "event.rejected") return false;
  if (e.kind !== "runtime.event") return true; // Unknown future records are protected by default.
  return !["agent.state", "agent.heartbeat", "metrics", "tool.progress", "stage", "log"].includes(e.data.type);
}
export async function decodeArchive(bytes: Buffer, expected?: ArchiveRef): Promise<MemoryArchive> {
  const value = JSON.parse((await unzip(bytes)).toString("utf8")) as MemoryArchive;
  const { digest: actual, ...body } = value;
  if (value.version !== 1 || digest(body) !== actual || (expected && (expected.digest !== actual || expected.from !== value.from || expected.to !== value.to || expected.lastHash !== value.lastHash))) throw new Error("Memory archive integrity failure");
  return value;
}
export async function directoryBytes(directory: string): Promise<number> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (e: any) { if (e.code === "ENOENT") return 0; throw e; }
  let total = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    try { total += entry.isDirectory() ? await directoryBytes(file) : (await fs.promises.stat(file)).size; }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  return total;
}
export async function cleanAbandonedDrafts(root: string, directory: string, now: number, retentionMs: number) {
  for (const sub of ["", "memory", "index"]) {
    const parent = path.join(directory, sub);
    const names = await fs.promises.readdir(parent).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
    for (const name of names) {
      if (!/\.[a-f0-9-]{36}\.tmp$/.test(name) && !/^journal\.jsonl\.torn-[a-f0-9-]{36}$/.test(name)) continue;
      const file = path.join(parent, name), stat = await fs.promises.lstat(file);
      // Never race a fresh atomic writer. These files are uncommitted drafts;
      // committed baselines and archives have different, fixed names.
      const lockDraft=/^journal\.jsonl\.lock\.(\d+)\.[a-f0-9-]{36}\.tmp$/.exec(name);
      if(lockDraft&&stat.isDirectory()&&!stat.isSymbolicLink()&&now-stat.mtimeMs>Math.max(86400000,retentionMs)){
        let dead=false;try{process.kill(Number(lockDraft[1]),0);}catch(e:any){if(e.code==='ESRCH')dead=true;else throw e;}
        if(dead){const entries=await fs.promises.readdir(file);if(entries.every(n=>n==='owner')){if(entries.length)await unlinkManaged(root,path.join(file,'owner'));await fs.promises.rmdir(file);}}
      }
      if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > Math.max(86400000, retentionMs)) await unlinkManaged(root, file);
    }
  }
}
