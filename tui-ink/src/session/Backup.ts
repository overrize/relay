import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { digest, writeBuffer, unlinkManaged, decodeArchive, parseEvents, yieldIO, type RetentionBase } from "./Storage.js";
import { acquireWorkspaceOwnership } from "./RuntimeOwner.js";

export interface BackupFile { name: string; bytes?: Buffer; file?: string }
interface ObjectRef { name: string; sha: string; bytes: number }
export interface BackupManifest { version: 1; id: string; root: string; createdAt: number; seq: number; lastHash: string; files: ObjectRef[]; digest: string }
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const validName = (name: string) => /^(?:retention(?:\.backup)?\.json|segments\/\d{16}-\d{16}\.jsonl|memory\/\d{16}-\d{16}\.mem\.gz)$/.test(name);
export const backupDirectory = (root: string) => path.resolve(process.env.SPAWN_BACKUP_DIR ?? `${path.resolve(root)}-backups`, createHash("sha256").update(process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)).digest("hex").slice(0, 16));
const jobs = new Map<string, Promise<unknown>>();
async function exclusive<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const task = (jobs.get(directory) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await fs.promises.mkdir(directory, { recursive: true });
    const lock = path.join(directory, "backup.lock");
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(lock, "wx", 0o600); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(await fs.promises.readFile(lock, "utf8"));
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("Backup lock is invalid; inspect before retrying");
      let dead = false; try { process.kill(owner, 0); } catch (e: any) { if (e.code === "ESRCH") dead = true; else throw e; }
      if (!dead) throw new Error("Another process is using this backup store; retry later");
      await fs.promises.unlink(lock); handle = await fs.promises.open(lock, "wx", 0o600);
    }
    try { await handle.writeFile(String(process.pid)); await handle.sync(); return await work(); }
    finally { await handle.close(); await fs.promises.unlink(lock); }
  });
  jobs.set(directory, task); void task.finally(() => { if (jobs.get(directory) === task) jobs.delete(directory); }).catch(() => {});
  return task;
}
function parseManifest(bytes: Buffer): BackupManifest {
  const m = JSON.parse(bytes.toString("utf8")) as BackupManifest, { digest: actual, ...body } = m;
  if (m.version !== 1 || digest(body) !== actual || !Number.isSafeInteger(m.seq) || !Array.isArray(m.files) || !m.files.length || m.files.some((f) => !validName(f.name) || !/^[a-f0-9]{64}$/.test(f.sha) || !Number.isSafeInteger(f.bytes) || f.bytes < 0) || new Set(m.files.map((f) => f.name)).size !== m.files.length) throw new Error("Invalid backup manifest");
  return m;
}
async function snapshotNames(directory: string) {
  const names = await fs.promises.readdir(path.join(directory, "snapshots")).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  const rows = await Promise.all(names.filter((n) => /^\d{16}-[a-f0-9]{16}\.json$/.test(n)).map(async (name) => ({ name, time: (await fs.promises.stat(path.join(directory, "snapshots", name))).mtimeMs })));
  return rows.sort((a, b) => Number(b.name.slice(0, 16)) - Number(a.name.slice(0, 16)) || b.time - a.time).map((r) => r.name);
}
async function manifests(directory: string) {
  const names = await snapshotNames(directory);
  const result: BackupManifest[] = [];
  for (const name of names) {
    try { const m = parseManifest(await fs.promises.readFile(path.join(directory, "snapshots", name))); if (`${m.id}.json` === name) result.push(m); } catch { /* Invalid snapshots are not offered as recoverable. */ }
  }
  return result.sort((a, b) => b.seq - a.seq || b.createdAt - a.createdAt);
}
async function verifyObjects(directory: string, m: BackupManifest) {
  const byName = new Map(m.files.map((f) => [f.name, f]));
  const read = async (ref: ObjectRef) => {
    const bytes = await fs.promises.readFile(path.join(directory, "objects", `${ref.sha}.blob`));
    if (bytes.length !== ref.bytes || sha(bytes) !== ref.sha) throw new Error(`Backup object is missing or corrupt: ${ref.name}`);
    return bytes;
  };
  let base: RetentionBase | undefined;
  for (const ref of m.files.filter((f) => f.name.startsWith("retention"))) {
    const b = JSON.parse((await read(ref)).toString("utf8")) as RetentionBase, { digest: actual, ...body } = b;
    if (b.version !== 1 || digest(body) !== actual || !Array.isArray(b.archives) || !b.state || (base && base.digest !== b.digest)) throw new Error("Backup retention baseline integrity failure");
    base = b;
  }
  let nextArchive = 1;
  for (const archive of base?.archives ?? []) {
    if (archive.from !== nextArchive || archive.to < archive.from) throw new Error("Backup memory sequence gap");
    const ref = byName.get(`memory/${archive.name}`);
    if (!ref || ref.bytes !== archive.bytes) throw new Error("Backup is missing protected memory");
    await decodeArchive(await read(ref), archive); nextArchive = archive.to + 1;
  }
  if (base && (nextArchive !== base.state.seq + 1 || base.archives.at(-1)?.lastHash !== base.state.lastHash)) throw new Error("Backup memory boundary mismatch");
  if (m.files.filter((f) => f.name.startsWith("memory/")).length !== (base?.archives.length ?? 0)) throw new Error("Unexpected backup memory source");
  let seq = base?.state.seq ?? 0, previous = base?.state.lastHash ?? "";
  for (const ref of m.files.filter((f) => f.name.startsWith("segments/")).sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await read(ref), range = /\/(\d+)-(\d+)\.jsonl$/.exec(ref.name)!;
    if (Number(range[1]) !== seq + 1 || bytes.at(-1) !== 10) throw new Error("Backup raw segment sequence gap or torn record");
    for (const event of parseEvents(bytes)) {
      const { hash: actual, ...body } = event;
      if (event.version !== 1 || event.seq !== seq + 1 || sha(Buffer.from(previous + JSON.stringify(body))) !== actual) throw new Error("Backup raw event integrity failure");
      seq = event.seq; previous = actual;
      if (seq % 100 === 0) await yieldIO();
    }
    if (seq !== Number(range[2])) throw new Error("Backup raw boundary mismatch");
  }
  if (seq !== m.seq || previous !== m.lastHash) throw new Error("Backup final sequence mismatch");
}
export async function listBackups(root: string) { return exclusive(backupDirectory(root), () => manifests(backupDirectory(root))); }
export async function verifyBackups(root: string) {
  const directory = backupDirectory(root);
  return exclusive(directory, async () => {
    const result: Array<{ id: string; seq: number; valid: boolean; error?: string }> = [];
    for (const m of await manifests(directory)) try { await verifyObjects(directory, m); result.push({ id: m.id, seq: m.seq, valid: true }); } catch (error) { result.push({ id: m.id, seq: m.seq, valid: false, error: String(error) }); }
    for (const name of await snapshotNames(directory)) if (!result.some((r) => `${r.id}.json` === name)) result.push({ id: name.slice(0, -5), seq: Number(name.slice(0, 16)), valid: false, error: "Invalid backup manifest" });
    return result.sort((a, b) => b.seq - a.seq);
  });
}
export async function repairArchives(root: string) {
  const directory = backupDirectory(root), release = acquireWorkspaceOwnership(root, "restore");
  try { return await exclusive(directory, async () => {
    const baselines: RetentionBase[] = [];
    for (const name of ["retention.json", "retention.backup.json"]) try {
      const b = JSON.parse(await fs.promises.readFile(path.join(root, ".spawn/events", name), "utf8")) as RetentionBase, { digest: actual, ...body } = b;
      if (b.version === 1 && digest(body) === actual && b.archives.every((a) => /^\d{16}-\d{16}\.mem\.gz$/.test(a.name))) baselines.push(b);
    } catch { /* Try the other independently written baseline. */ }
    const baseline = baselines.sort((a, b) => b.generation - a.generation)[0];
    if (!baseline) throw new Error("No valid local baseline; choose an explicit full snapshot restore instead");
    const snapshots = await manifests(directory), repaired: string[] = [];
    for (const archive of baseline.archives) {
      const file = path.join(root, ".spawn/events/memory", archive.name);
      try { await decodeArchive(await fs.promises.readFile(file), archive); continue; } catch { /* Seek an exact verified copy, not an older memory revision. */ }
      let restored: Buffer | undefined;
      for (const m of snapshots) {
        const ref = m.files.find((f) => f.name === `memory/${archive.name}` && f.bytes === archive.bytes); if (!ref) continue;
        try { const bytes = await fs.promises.readFile(path.join(directory, "objects", `${ref.sha}.blob`)); if (sha(bytes) !== ref.sha) continue; await decodeArchive(bytes, archive); restored = bytes; break; } catch { /* Try another snapshot. */ }
      }
      if (!restored) throw new Error(`No exact verified backup for ${archive.name}; current goal/logs were not rolled back`);
      if (fs.existsSync(file)) { const quarantine = path.join(root, ".spawn/repair-quarantine", `${randomUUID()}-${archive.name}`); await fs.promises.mkdir(path.dirname(quarantine), { recursive: true }); await fs.promises.rename(file, quarantine); }
      await writeBuffer(file, restored); repaired.push(archive.name);
    }
    return { root, repaired, goalRolledBack: false };
  }); } finally { release(); }
}
export async function createBackup(root: string, seq: number, lastHash: string, files: BackupFile[]) {
  const directory = backupDirectory(root);
  if (directory === path.resolve(root) || directory.startsWith(path.resolve(root, ".spawn") + path.sep)) throw new Error("Backup store must be separate from .spawn");
  return exclusive(directory, async () => {
    const refs: ObjectRef[] = [];
    for (const file of files) {
      if (!validName(file.name)) throw new Error("Unexpected backup source path");
      const bytes = file.bytes ?? await fs.promises.readFile(file.file!);
      const ref = { name: file.name, sha: sha(bytes), bytes: bytes.length }; refs.push(ref);
      const object = path.join(directory, "objects", `${ref.sha}.blob`);
      let valid = false; try { valid = sha(await fs.promises.readFile(object)) === ref.sha; } catch { /* upload or repair */ }
      if (!valid) await writeBuffer(object, bytes);
    }
    refs.sort((a, b) => a.name.localeCompare(b.name));
    const id = `${String(seq).padStart(16, "0")}-${digest({ lastHash, refs }).slice(0, 16)}`;
    const file = path.join(directory, "snapshots", `${id}.json`);
    let m: BackupManifest;
    try { m = parseManifest(await fs.promises.readFile(file)); await verifyObjects(directory, m); }
    catch {
      const body = { version: 1 as const, id, root: path.resolve(root), createdAt: Date.now(), seq, lastHash, files: refs };
      m = { ...body, digest: digest(body) }; await verifyObjects(directory, m);
      await writeBuffer(file, Buffer.from(JSON.stringify(m))); parseManifest(await fs.promises.readFile(file));
    }
    const keep = Number(process.env.SPAWN_BACKUP_KEEP ?? 5);
    if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("SPAWN_BACKUP_KEEP must be at least 1");
    const snapshots = await manifests(directory), retained: BackupManifest[] = [];
    for (const snapshot of snapshots) {
      try { await verifyObjects(directory, snapshot); retained.push(snapshot); } catch { continue; }
    }
    for (const old of retained.slice(keep)) await unlinkManaged(directory, path.join(directory, "snapshots", `${old.id}.json`));
    // Grace period also protects upload artifacts left by an interrupted backup.
    const remaining = await manifests(directory), live = new Set(remaining.flatMap((s) => s.files.map((f) => f.sha)));
    for (const name of await fs.promises.readdir(path.join(directory, "objects"))) if (/^[a-f0-9]{64}\.blob$/.test(name) && !live.has(name.slice(0, -5))) {
      const target = path.join(directory, "objects", name);
      if (Date.now() - (await fs.promises.stat(target)).mtimeMs > 86400000) await unlinkManaged(directory, target);
    }
    return { directory, id: m.id, seq: m.seq, files: m.files.length };
  });
}

export async function restoreBackup(sourceRoot: string, destination: string, options: { id?: string; replace?: boolean } = {}) {
  const directory = backupDirectory(sourceRoot), root = path.resolve(destination);
  return exclusive(directory, async () => {
    const release = acquireWorkspaceOwnership(root, "restore");
    try {
    const events = path.join(root, ".spawn", "events"), txFile = path.join(root, ".spawn", "restore-transaction.json");
    const { SessionJournal } = await import("./Journal.js");
    const finish = async (tx: { token: string; seq: number; lastHash: string }) => {
      if (!/^[a-f0-9-]{36}$/.test(tx.token)) throw new Error("Invalid restore transaction");
      const staging = path.join(root, ".spawn", `events.restore-${tx.token}`), previous = path.join(root, ".spawn", `events.before-restore-${tx.token}`);
      if (fs.existsSync(staging)) {
        if (fs.existsSync(events)) { if (fs.existsSync(previous)) throw new Error("Ambiguous restore state; inspect all preserved directories"); await fs.promises.rename(events, previous); }
        await fs.promises.rename(staging, events);
      }
      const restored = new SessionJournal(root, { allowRestoreTransaction: true });
      if (restored.sequence().seq !== tx.seq || restored.sequence().lastHash !== tx.lastHash) throw new Error("Restored sequence does not match backup; previous data was preserved");
      await fs.promises.unlink(txFile); return { root, seq: tx.seq, previous: fs.existsSync(previous) ? previous : undefined };
    };
    if (fs.existsSync(txFile)) return { ...(await finish(JSON.parse(await fs.promises.readFile(txFile, "utf8")))), resumedTransaction: true };
    if (fs.existsSync(events) && !options.replace) throw new Error("Destination already has event data; use replace explicitly or restore to an empty workspace");
    const available = (await manifests(directory)).filter((m) => !options.id || m.id === options.id);
    const latestAvailable = (await snapshotNames(directory)).find((name) => !options.id || name === `${options.id}.json`)?.slice(0, -5);
    let selected: BackupManifest | undefined;
    for (const m of available) { try { await verifyObjects(directory, m); selected = m; break; } catch { /* Try an older verified recovery point. */ } }
    if (!selected) throw new Error("No verified backup is available; destination was not modified");
    const token = randomUUID(), staging = path.join(root, ".spawn", `events.restore-${token}`);
    for (const ref of selected.files) await writeBuffer(path.join(staging, ...ref.name.split("/")), await fs.promises.readFile(path.join(directory, "objects", `${ref.sha}.blob`)));
    // Validate the complete reconstructed chain without installing it in place.
    const inspectRoot = path.join(root, ".spawn", `restore-check-${token}`);
    await fs.promises.mkdir(path.join(inspectRoot, ".spawn"), { recursive: true });
    await fs.promises.rename(staging, path.join(inspectRoot, ".spawn", "events"));
    const check = new SessionJournal(inspectRoot).sequence();
    if (check.seq !== selected.seq || check.lastHash !== selected.lastHash) throw new Error("Backup recovery chain verification failed; destination was preserved");
    await fs.promises.rename(path.join(inspectRoot, ".spawn", "events"), staging);
    const tx = { token, seq: selected.seq, lastHash: selected.lastHash };
    await writeBuffer(txFile, Buffer.from(JSON.stringify(tx)));
    return { ...(await finish(tx)), id: selected.id, latestAvailable, fallback: selected.id !== latestAvailable };
    } finally { release(); }
  });
}
