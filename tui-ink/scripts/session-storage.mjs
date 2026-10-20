import fs from "node:fs";
import path from "node:path";
import { SessionJournal } from "../dist/session/Journal.js";
import { storagePolicy } from "../dist/session/Storage.js";

const root = path.resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? process.cwd());
if (process.argv.includes("--clean")) {
  const report = await new SessionJournal(root).maintain();
  console.log(JSON.stringify({ root, ...report }, null, 2));
  if (report.errors.length) process.exitCode = 1;
} else {
  let lastMaintenance;
  try { lastMaintenance = JSON.parse(fs.readFileSync(path.join(root, ".spawn/events/storage-status.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  console.log(JSON.stringify({ root, configuredPolicy: storagePolicy(), lastMaintenance: lastMaintenance ?? null }, null, 2));
}
