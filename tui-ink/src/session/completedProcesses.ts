import fs from "node:fs";
import path from "node:path";
import { directoryBytes, unlinkManaged, type StoragePolicy } from "./Storage.js";

/** Only archived, terminal operations are eligible. Running/blocked records and
 * unexpected files are preserved; deletion never follows links or recurses. */
export async function cleanCompletedProcesses(root: string, policy: StoragePolicy, now: number) {
  const directory = path.join(root, ".spawn", "processes", "completed");
  const names = await fs.promises.readdir(directory).catch((e) => { if (e.code === "ENOENT") return []; throw e; });
  const eligible: Array<{ dir: string; time: number; bytes: number; files: string[] }> = [];
  for (const token of names) {
    if (!/^[a-f0-9-]{36}$/.test(token)) continue;
    const dir = path.join(directory, token), stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    try {
      const record = JSON.parse(await fs.promises.readFile(path.join(dir, "record.json"), "utf8"));
      if (record.token !== token || !["completed", "cancelled", "failed", "abandoned"].includes(record.status)) continue;
      const files = await fs.promises.readdir(dir);
      if (files.some((file) => !["intent.json", "record.json", "lease", "cancel"].includes(file))) continue;
      eligible.push({ dir, time: Number(record.updatedAt ?? stat.mtimeMs), bytes: await directoryBytes(dir), files });
    } catch { /* Incomplete or concurrently changing records must be inspected. */ }
  }
  let total = eligible.reduce((n, e) => n + e.bytes, 0), removed = 0;
  for (const entry of eligible.sort((a, b) => a.time - b.time)) {
    if (now - entry.time < policy.processRetentionMs && total <= policy.maxCompletedProcessBytes) continue;
    for (const file of entry.files.filter((f) => f !== "record.json")) await unlinkManaged(root, path.join(entry.dir, file));
    await unlinkManaged(root, path.join(entry.dir, "record.json"));
    await fs.promises.rmdir(entry.dir); total -= entry.bytes; removed++;
  }
  return removed;
}
