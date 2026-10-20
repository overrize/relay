import path from "node:path";
import { SessionJournal } from "../dist/session/Journal.js";
import { backupDirectory, listBackups, verifyBackups, repairArchives, restoreBackup } from "../dist/session/Backup.js";

const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = path.resolve(option("root") ?? process.cwd());
const command = process.argv[2] ?? "list";
try {
  let result;
  if (command === "create") result = await new SessionJournal(root).backup();
  else if (command === "list") result = { directory: backupDirectory(root), snapshots: (await listBackups(root)).map(({ id, seq, createdAt, files }) => ({ id, seq, createdAt, files: files.length })) };
  else if (command === "verify") { result = await verifyBackups(root); if (result.some((r) => !r.valid)) process.exitCode = 1; }
  else if (command === "repair-archives") result = await repairArchives(root);
  else if (command === "restore") {
    if (!option("to")) throw new Error("Specify --to=E:\\destination; stop that workspace first. Existing event data requires --replace.");
    result = await restoreBackup(root, path.resolve(option("to")), { id: option("id"), replace: process.argv.includes("--replace") });
  } else throw new Error("Commands: create | list | verify | repair-archives | restore --to=PATH [--id=ID] [--replace], with --root=PATH");
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
