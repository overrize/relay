import { waitForSessionControl } from "../session/Control.js";
import { sessionJournal } from "../session/Journal.js";
import { beginTaskOperation, finishTaskOperation, workItems } from "../session/Tasks.js";
import { retryTask, reviewTask, taskMode, reconcileTask } from "../runtime/TaskRecovery.js";
import { consumeSessionTool, budgetReport } from "../session/Budget.js";
import { toolWorkspace, resolveWorkspaceToolPath, withWorkspace, workspaceChanges, publishWorkspace, resolveWorkspace } from "../session/Workspaces.js";
import { taskState } from "../session/Tasks.js";
// Tool Registry — 每个工具是独立的 ToolDef 对象，单一职责
// 架构借鉴自 claude_leack ExecutionRegistry 的 frozen-dataclass 思路
// 但实现了真正的执行逻辑（他们的 execute_tool 只是 stub）

import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import * as http from "node:http";
import * as os from "node:os";
import { execCommand, withToolCancellation } from "./command.js";
export { cancelAgentTools } from "./command.js";
// playwright 在运行时通过动态 import() 加载，以允许未安装时不阻塞编译
import { WorkspaceBoundary } from "../execution/WorkspaceBoundary.js";
import { loadConfig, type WebSearchProviderConfig } from "../config.js";
import { recordHealthMetric } from "../runtime/HealthMetrics.js";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface ToolResult {
  ok: boolean;
  output: string;
  code?: "invalid_args" | string;
}

export type AgentRole = "Leader" | "Worker";

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly argsSchema: string;      // 注入 system prompt 用
  readonly needsApproval: boolean;  // true = 走 y/n 审批门
  readonly roles: ReadonlySet<AgentRole>;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

type ToolArgType = "string" | "int" | "number" | "boolean" | "enum";

interface ToolArgField {
  readonly type: ToolArgType;
  readonly required?: boolean;
  readonly aliases?: readonly string[];
  readonly values?: readonly string[];
  readonly default?: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly allowEmpty?: boolean;
  readonly description?: string;
}

type ToolArgSpec = Record<string, ToolArgField>;

function resolveToolPath(inputPath: string): ToolResult & { path?: string } {
  if (toolWorkspace() !== process.cwd()) { try { return { ok: true, output: "", path: resolveWorkspaceToolPath(inputPath) }; } catch (error) { return err(String(error)); } }
  const boundary = new WorkspaceBoundary(process.cwd(), [os.tmpdir()]);
  const resolved = boundary.resolveInside(inputPath);
  if (!resolved.ok) return err(`Path rejected: ${resolved.reason} (${resolved.path})`);
  return { ok: true, output: "", path: resolved.path };
}

// ── 工具实现 ──────────────────────────────────────────────────────────────────

const SessionRecall: ToolDef = {
  name: "SessionRecall", description: "按关键词检索本会话持久事件，返回事件序号、需求版本和片段。旧版本仅供参考，不代表当前目标。",
  argsSchema: "query(str), limit?(int default:10)", needsApproval: false, roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const id = String(a.__sessionAgent ?? "");
    const binding = sessionJournal().binding(id);
    if (!binding) return err("No durable session is bound to this tool call");
    return ok(JSON.stringify(await sessionJournal().search(binding.conversation, String(a.query ?? ""), Number(a.limit ?? 10))));
  },
};
const TaskStatus: ToolDef = {
  name: "TaskStatus", description: "查询本会话子任务的持久状态、停止原因、交接、证据和未完成事项。子任务自报成功不代表已独立验收。",
  argsSchema: "agent?(str), task?(str logical task ID), offset?(int default:0), limit?(int default:10)", needsApproval: false, roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const journal = sessionJournal(), binding = journal.binding(String(a.__sessionAgent ?? ""));
    if (!binding) return err("No durable session is bound");
    const summarize = (t: NonNullable<ReturnType<typeof workItems>[number]>) => ({ id: t.id, status: t.status, reason: t.reason.slice(0, 500), profile: t.profile, mode: t.mode, attempts: t.attempts, maxAttempts: t.maxAttempts, turns: [t.usedTurns, t.maxTurns], requests: [t.usedRequests, t.maxRequests], tools: [t.usedTools, t.maxTools], deadline: t.deadline, nextAt: t.nextAt, verdict: t.verdict && { ...t.verdict, details: t.verdict.details.slice(0, 4).map((s) => s.slice(0, 300)) } });
    if (a.task) {
      const t = workItems(journal, binding.conversation).find((w) => w.id === a.task); if (!t) return err("Logical task not found in this conversation");
      const rows = Object.values(t.operations), offset = Math.max(0, Math.floor(Number(a.offset) || 0)), page: unknown[] = []; let bytes = 2500;
      for (const op of rows.slice(offset, offset + Math.min(10, Math.max(1, Number(a.limit) || 10)))) { const row = { ...op, output: op.output?.slice(-300) }, size = JSON.stringify(row).length; if (page.length && bytes + size > 9500) break; page.push(row); bytes += size; }
      return ok(JSON.stringify({ ...summarize(t), goal: t.goal.slice(0, 700), totalOperations: rows.length, operations: page, nextOffset: offset + page.length < rows.length ? offset + page.length : null }));
    }
    const tasks = journal.tasks(binding.conversation).filter((t) => !a.agent || t.id === a.agent).reverse();
    const offset = Math.max(0, Math.floor(Number(a.offset) || 0)), limit = Math.min(20, Math.max(1, Math.floor(Number(a.limit) || 10)));
    const page: unknown[] = []; let bytes = 0;
    for (const task of tasks.slice(offset, offset + limit)) {
      const cut = (items: string[]) => items.slice(0, 5).map((s) => String(s).slice(0, 300));
      const control = task.workId && journal.current(binding.conversation)?.work?.[task.workId];
      const row = { id: task.id, parent: task.parent, role: task.role, revision: task.revision, status: task.status, goal: task.goal.slice(0, 700), lastError: task.lastError?.slice(0, 500), control: control && summarize(control), outcome: task.outcome && { ...task.outcome, reason: task.outcome.reason.slice(0, 500), summary: task.outcome.summary.slice(0, 1200), evidence: cut(task.outcome.evidence), remaining: cut(task.outcome.remaining), artifacts: cut(task.outcome.artifacts) } };
      const size = JSON.stringify(row).length; if (page.length && bytes + size > 9500) break;
      page.push(row); bytes += size;
    }
    return ok(JSON.stringify({ total: tasks.length, offset, nextOffset: offset + page.length < tasks.length ? offset + page.length : null, tasks: page, detail: "Fields are abbreviated; query agent for a specific task and SessionRecall for full historical evidence." }));
  },
};
const TaskRetry: ToolDef = {
  name: "TaskRetry", description: "PM 在原逻辑任务共享预算内申请续派；必须说明具体调整方案，不能绕过不确定副作用或耗尽预算。", argsSchema: "task(str), reason(str)", needsApproval: false, roles: new Set(["Leader"]),
  async execute(a) { const t = retryTask(String(a.__sessionAgent), String(a.task), String(a.reason)); return ok(JSON.stringify({ id: t.id, status: t.status, reason: t.reason, attempts: t.attempts.length, maxAttempts: t.maxAttempts })); },
};
const TaskReview: ToolDef = {
  name: "TaskReview", description: "PM 独立验收：evidence 为逗号分隔的本 PM 检查工具调用 ID，不能使用 Worker 自报或旧验收证据。", argsSchema: "task(str), verdict(accept|reject), evidence(str), rationale(str)", needsApproval: false, roles: new Set(["Leader"]),
  async execute(a) { const t = reviewTask(String(a.__sessionAgent), String(a.task), a.verdict as "accept" | "reject", String(a.evidence).split(",").map((s) => s.trim()).filter(Boolean), String(a.rationale)); if (t.status === "accepted") try { await publishWorkspace(t); } catch (error) { taskState(t, { status: "blocked", reason: `workspace-publish:${String(error)}` }); return err(String(error)); } return ok(JSON.stringify({ id: t.id, status: t.status, verdict: t.verdict })); },
};
const TaskPolicy: ToolDef = {
  name: "TaskPolicy", description: "暂停/恢复指定任务的后续自动续派，不中断正在运行的 Worker，也不会重置任何预算。", argsSchema: "task(str), mode(auto|manual)", needsApproval: false, roles: new Set(["Leader"]),
  async execute(a) { const t = taskMode(String(a.__sessionAgent), String(a.task), a.mode as "auto" | "manual"); return ok(JSON.stringify({ id: t.id, mode: t.mode, status: t.status })); },
};
const TaskReconcile: ToolDef = {
  name: "TaskReconcile", description: "PM 实际检查不确定副作用后，将指定操作标为不得重复；必须提供新的独立检查调用 ID 和理由。仅解锁剩余工作，不增加预算，不自动重放旧命令。", argsSchema: "task(str), operation(str), evidence(str comma separated call IDs), reason(str)", needsApproval: false, roles: new Set(["Leader"]),
  async execute(a) { const t = reconcileTask(String(a.__sessionAgent), String(a.task), String(a.operation), String(a.evidence).split(",").map((s) => s.trim()).filter(Boolean), String(a.reason)); return ok(JSON.stringify({ id: t.id, status: t.status, operation: a.operation, reconciliation: t.operations[String(a.operation)]?.reconciliation })); },
};
const BudgetStatus: ToolDef = { name: "BudgetStatus", description: "只读查询整个工作区会话的持久预算，包括 PM、Leader、Worker、重试与验收。模型不能增加额度。", argsSchema: "", needsApproval: false, roles: new Set(["Leader", "Worker"]), async execute() { return ok(JSON.stringify(budgetReport())); } };
const WorkspaceStatus: ToolDef = { name: "WorkspaceStatus", description: "查看隔离任务的修改、冲突、当前原文件哈希。Read(task=逻辑任务ID) 可检查暂存版本。", argsSchema: "task(str)", needsApproval: false, roles: new Set(["Leader", "Worker"]), async execute(a) { const b = sessionJournal().binding(String(a.__sessionAgent)), t = b && workItems(sessionJournal(), b.conversation).find((w) => w.id === a.task); if (!t) return err("Task not found"); const changes = await workspaceChanges(t); return ok(JSON.stringify({ id: t.id, isolation: t.isolation, status: t.workspace?.status, conflicts: t.workspace?.conflicts, changes: changes.slice(0, 30), total: changes.length })); } };
const WorkspaceResolve: ToolDef = { name: "WorkspaceResolve", description: "PM 按当前哈希显式解决停止任务的单个文件冲突。ours 保留任务版本，theirs 保留原工作区版本；不会自动覆盖变化后的目标。", argsSchema: "task(str), path(str), expected(str current hash or missing), choice(ours|theirs)", needsApproval: false, roles: new Set(["Leader"]), async execute(a) { await resolveWorkspace(String(a.__sessionAgent), String(a.task), String(a.path), String(a.expected), String(a.choice)); return ok("Resolution recorded; use WorkspacePublish or retry/review after inspecting the result"); } };
const WorkspacePublish: ToolDef = { name: "WorkspacePublish", description: "PM 显式发布停止任务的已检查暂存修改；发布前再次检查文件哈希，冲突时保留双方版本并拒绝覆盖。", argsSchema: "task(str)", needsApproval: false, roles: new Set(["Leader"]), async execute(a) { const b = sessionJournal().binding(String(a.__sessionAgent)), t = b && workItems(sessionJournal(), b.conversation).find((w) => w.id === a.task); if (!t || b?.role !== "Leader" || (b.id !== t.parent && b.id !== t.conversation) || ["running", "evaluating", "retry_wait"].includes(t.status)) return err("Only the owner/root PM may publish a stopped task"); await publishWorkspace(t); return ok("Changes published; acceptance remains a separate decision"); } };

const Read: ToolDef = {
  name: "Read",
  description: "读文件，带行号",
  argsSchema: "path(str), offset?(int 行号), limit?(int default:200)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const inputPath = String(a.file_path ?? a.path ?? "");
    if (!inputPath) return err("missing path");
    const rp = resolveToolPath(inputPath);
    if (!rp.ok || !rp.path) return rp;
    const p = rp.path;
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(0, typeof a.offset === "number" ? a.offset : 0);
    const limit = typeof a.limit === "number" ? a.limit : 200;
    const end = Math.min(lines.length, start + limit);
    const body = lines.slice(start, end)
      .map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return ok(`${p} (lines ${start + 1}–${end} / ${lines.length})\n${body}`);
  },
};

const Write: ToolDef = {
  name: "Write",
  description: "写文件（覆盖/新建，自动建目录）",
  argsSchema: "path(str), content(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const inputPath = String(a.file_path ?? a.path ?? "");
    const content = String(a.content ?? "");
    if (!inputPath) return err("missing path");
    const rp = resolveToolPath(inputPath);
    if (!rp.ok || !rp.path) return rp;
    const p = rp.path;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return ok(`Written ${content.length} chars to ${p}`);
  },
};

const Edit: ToolDef = {
  name: "Edit",
  description: "精确字符串替换，old_string 必须唯一",
  argsSchema: "path(str), old_string(str), new_string(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const inputPath = String(a.file_path ?? a.path ?? "");
    const oldStr = String(a.old_string ?? "");
    const newStr = String(a.new_string ?? "");
    if (!inputPath) return err("missing path");
    const rp = resolveToolPath(inputPath);
    if (!rp.ok || !rp.path) return rp;
    const p = rp.path;
    // Empty old_string → create new file (only if it doesn't exist)
    if (!oldStr) {
      if (fs.existsSync(p)) return err("old_string is empty but file exists; use Write to overwrite");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, newStr, "utf8");
      return ok(`Created ${p} (${newStr.length} chars)`);
    }
    const raw = fs.readFileSync(p, "utf8");
    // Normalize to LF for matching so Windows CRLF files work with LF old_string.
    const hasCrlf = raw.includes("\r\n");
    const content = hasCrlf ? raw.replace(/\r\n/g, "\n") : raw;
    const normalizedOld = oldStr.replace(/\r\n/g, "\n");
    const normalizedNew = newStr.replace(/\r\n/g, "\n");
    const count = content.split(normalizedOld).length - 1;
    if (count === 0) return err(`old_string not found in ${p}`);
    if (count > 1)   return err(`old_string found ${count} times in ${p}; be more specific`);
    // When deleting (newStr=""), also handle trailing newline
    let updated: string;
    if (normalizedNew === "" && !normalizedOld.endsWith("\n") && content.includes(normalizedOld + "\n")) {
      updated = content.replace(normalizedOld + "\n", "");
    } else {
      updated = content.replace(normalizedOld, normalizedNew);
    }
    // Restore original line endings
    const finalContent = hasCrlf ? updated.replace(/\n/g, "\r\n") : updated;
    fs.writeFileSync(p, finalContent, "utf8");
    return ok(`Edited ${p}: replaced 1 occurrence`);
  },
};

const BANNED_COMMANDS = new Set([
  "nc", "ncat", "netcat", "telnet", "ssh", "scp", "ftp", "rsync",
  "curl", "wget", "http", "https",
  "head",  // not available on Windows; output is already truncated by the tool
]);
function isBanned(cmd: string): string | null {
  const first = cmd.trim().split(/[\s|;&<>]/)[0]?.split(/[/\\]/).pop() ?? "";
  return BANNED_COMMANDS.has(first.toLowerCase()) ? first : null;
}

const Bash: ToolDef = {
  name: "Bash",
  description: "异步执行 shell 命令（独立 shell，可取消，不保留跨调用环境）",
  argsSchema: "command(str), timeout?(ms default:60000)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const rawCmd = String(a.command ?? a.cmd ?? "");
    const timeout = typeof a.timeout === "number" ? a.timeout : 60_000;
    if (!rawCmd) return err("missing command");
    const banned = isBanned(rawCmd);
    if (banned) {
      const hint = banned === "head"
        ? `"head" is not available on Windows and output is already truncated. Remove the | head pipe.`
        : `"${banned}" is banned. Use Read/Grep/Glob/LS tools instead of network commands.`;
      return err(`Banned command: "${banned}". ${hint}`);
    }
    // On Windows CMD defaults to the system OEM code page (GBK on Chinese Windows).
    // Prepend chcp 65001 so stdout/stderr are UTF-8 and we can decode correctly.
    const cmd = process.platform === "win32" ? `chcp 65001 >nul 2>nul & ${rawCmd}` : rawCmd;
    const decodeOutput = (buf: Buffer | string): string => {
      if (typeof buf === "string") return buf;
      return buf.toString("utf8");
    };
    try {
      const raw = await execCommand(cmd, { encoding: "buffer", timeout, cwd: toolWorkspace(), shell: true as any });
      const out = decodeOutput(raw as unknown as Buffer);
      return ok(middleTruncate(out || "(no output)"));
    } catch (e: any) {
      const stdout = e.stdout ? decodeOutput(e.stdout) : "";
      const stderr = e.stderr ? decodeOutput(e.stderr) : "";
      const out = [stdout, stderr].filter(Boolean).join("\n").trim();
      return { ok: false, output: middleTruncate(out || e.message || "command failed", 10_000) };
    }
  },
};

const Grep: ToolDef = {
  name: "Grep",
  description: "正则搜索文件内容（基于 rg）",
  argsSchema: "pattern(str), path?(str), glob?(str), case_insensitive?(bool), context?(int)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const pat  = String(a.pattern ?? "");
    const rp = resolveToolPath(String(a.path ?? "."));
    if (!rp.ok || !rp.path) return rp;
    const dir = rp.path;
    const glob = a.glob ? `--glob ${JSON.stringify(String(a.glob))}` : "";
    const ci   = a.case_insensitive ? "-i" : "";
    const ctx  = typeof a.context === "number" ? `-C ${a.context}` : "";
    const cmd  = `rg -n --no-heading ${ci} ${ctx} ${glob} ${JSON.stringify(pat)} ${JSON.stringify(dir)}`.replace(/\s+/g, " ").trim();
    try {
      const out = String(await execCommand(cmd, { encoding: "utf8", timeout: 10_000, cwd: toolWorkspace() }));
      return ok(out.slice(0, 20_000) || "(no matches)");
    } catch (e: any) {
      return rgNotFoundResult(e, "Grep") ?? ok((String(e.stdout ?? "")).slice(0, 20_000) || "(no matches)");
    }
  },
};

const Glob: ToolDef = {
  name: "Glob",
  description: "文件名模式匹配，结果按路径排序",
  argsSchema: "pattern(str), path?(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const pat  = String(a.pattern ?? "**/*");
    const rp = resolveToolPath(String(a.path ?? "."));
    if (!rp.ok || !rp.path) return rp;
    const base = rp.path;
    try {
      const out = String(await execCommand(
        `rg --files --glob ${JSON.stringify(pat)} ${JSON.stringify(base)}`,
        { encoding: "utf8", timeout: 10_000, cwd: toolWorkspace() },
      ));
      const sorted = out.trim().split("\n").filter(Boolean).sort().join("\n");
      return ok(sorted.slice(0, 20_000) || "(no files)");
    } catch (e: any) {
      return rgNotFoundResult(e, "Glob") ?? ok((String(e.stdout ?? "")).slice(0, 20_000) || "(no files)");
    }
  },
};

const LS: ToolDef = {
  name: "LS",
  description: "列目录（d=目录 f=文件）",
  argsSchema: "path?(str default:cwd)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const rp = resolveToolPath(String(a.path ?? "."));
    if (!rp.ok || !rp.path) return rp;
    const dir = rp.path;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
    return ok(lines.join("\n") || "(empty)");
  },
};

const Think: ToolDef = {
  name: "Think",
  description: "记录推理步骤，无副作用，助于规划前的明确思考",
  argsSchema: "thought(str)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const t = String(a.thought ?? "");
    if (!t) return err("missing thought");
    return ok("Your thought has been logged.");
  },
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchUrl(url: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "spawn-agent/1.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchUrl(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── WebFetch ──────────────────────────────────────────────────────────────────

const WebFetch: ToolDef = {
  name: "WebFetch",
  description: "获取 URL 页面纯文本内容（自动去 HTML 标签，跟随跳转）",
  argsSchema: "url(str), max_chars?(int default:6000)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const url = String(a.url ?? "");
    if (!url) return err("missing url");
    if (!/^https?:\/\//i.test(url)) return err("url must start with http:// or https://");
    const maxChars = typeof a.max_chars === "number" ? Math.min(a.max_chars, 20_000) : 6_000;
    try {
      const raw = await fetchUrl(url);
      const text = stripHtml(raw);
      return ok(text.slice(0, maxChars) + (text.length > maxChars ? `\n\n[truncated ${text.length - maxChars} chars]` : ""));
    } catch (e: any) {
      return err(`WebFetch failed: ${e.message}`);
    }
  },
};

// ── WebSearch ─────────────────────────────────────────────────────────────────

const WebSearch: ToolDef = {
  name: "WebSearch",
  description: "互联网搜索，返回标题+URL+摘要列表（配置 web.search provider，兼容 BRAVE_SEARCH_API_KEY 或 SERPER_API_KEY）",
  argsSchema: "query(str), count?(int default:5)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const query = String(a.query ?? "");
    if (!query) return err("missing query");
    const appCfg = loadConfig();
    const configuredMax = appCfg.web.search.maxResults ?? 5;
    const count = Math.min(typeof a.count === "number" ? a.count : configuredMax, 10);
    const timeoutMs = Math.max(1, appCfg.web.search.timeoutSeconds ?? 10) * 1000;

    let provider: WebSearchProviderConfig | undefined;
    if (appCfg.web.search.enabled) {
      provider = appCfg.web.providers[appCfg.web.search.provider];
    }
    if (!provider && process.env.BRAVE_SEARCH_API_KEY) {
      provider = { type: "brave", apiKey: process.env.BRAVE_SEARCH_API_KEY };
    }
    if (!provider && process.env.SERPER_API_KEY) {
      provider = {
        type: "serper",
        apiKey: process.env.SERPER_API_KEY,
        ...(process.env.SERPER_HL ? { hl: process.env.SERPER_HL } : {}),
        ...(process.env.SERPER_GL ? { gl: process.env.SERPER_GL } : {}),
      };
    }

    if (provider?.type === "brave") {
      try {
        const json = await new Promise<string>((resolve, reject) => {
          const req = https.get(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
            { headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": provider.apiKey } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
              res.on("error", reject);
            },
          );
          req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
          req.on("error", reject);
        });
        const data = JSON.parse(json);
        const results = (data.web?.results ?? []).slice(0, count);
        if (!results.length) return ok("(no results)");
        return ok(results.map((r: { title: string; url: string; description: string }, i: number) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ""}`,
        ).join("\n\n"));
      } catch (e: any) {
        return err(`Brave Search failed: ${e.message}`);
      }
    }

    if (provider?.type === "serper") {
      try {
        const json = await new Promise<string>((resolve, reject) => {
          const body = JSON.stringify({
            q: query,
            num: count,
            ...(provider.hl ? { hl: provider.hl } : {}),
            ...(provider.gl ? { gl: provider.gl } : {}),
          });
          const endpoint = new URL(provider.baseUrl ?? "https://google.serper.dev/search");
          const req = https.request(
            { hostname: endpoint.hostname, path: endpoint.pathname + endpoint.search, method: "POST",
              headers: { "X-API-KEY": provider.apiKey, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
              res.on("error", reject);
            },
          );
          req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
          req.on("error", reject);
          req.write(body);
          req.end();
        });
        const data = JSON.parse(json);
        const results = (data.organic ?? []).slice(0, count);
        if (!results.length) return ok("(no results)");
        return ok(results.map((r: { title: string; link: string; snippet: string }, i: number) =>
          `${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.snippet ?? ""}`,
        ).join("\n\n"));
      } catch (e: any) {
        return err(`Serper Search failed: ${e.message}`);
      }
    }

    return err("WebSearch requires config.web.providers entry or BRAVE_SEARCH_API_KEY/SERPER_API_KEY in environment. Use /web connect serper <apiKey>.");
  },
};

// ── Coding tools ─────────────────────────────────────────────────────────────

// Decode a Buffer or string from a child process to UTF-8.
function decodeBuffer(buf: Buffer | string): string {
  return typeof buf === "string" ? buf : buf.toString("utf8");
}

/** Detect the project's test command and framework from the working directory. */
export function detectTestCommand(dir: string): { cmd: string; framework: string } | null {
  if (
    fs.existsSync(path.join(dir, "bun.lock")) ||
    fs.existsSync(path.join(dir, "bun.lockb")) ||
    fs.existsSync(path.join(dir, "bunfig.toml"))
  ) {
    return { cmd: "bun test", framework: "bun" };
  }

  // Node.js: package.json scripts.test
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    if (pkg.packageManager?.startsWith("bun@")) {
      return { cmd: "bun test", framework: "bun" };
    }
    const testScript = pkg.scripts?.test;
    if (testScript && !testScript.startsWith("echo ")) {
      if (/\bbun\s+test\b/.test(testScript)) return { cmd: "bun test", framework: "bun" };
      return { cmd: "npm test", framework: "node" };
    }
  } catch { /* no package.json */ }

  // Python: pytest
  if (
    fs.existsSync(path.join(dir, "pytest.ini")) ||
    fs.existsSync(path.join(dir, "pyproject.toml")) ||
    fs.existsSync(path.join(dir, "setup.py"))
  ) {
    return { cmd: "python -m pytest -v", framework: "pytest" };
  }

  // Rust
  if (fs.existsSync(path.join(dir, "Cargo.toml"))) {
    return { cmd: "cargo test", framework: "cargo" };
  }

  // Go
  if (fs.existsSync(path.join(dir, "go.mod"))) {
    return { cmd: "go test ./...", framework: "go" };
  }

  return null;
}

interface TestCounts { passed: number; failed: number; skipped: number; }

/** Parse common test-runner output formats into pass/fail counts. */
export function parseTestCounts(output: string, framework: string): TestCounts {
  const r: TestCounts = { passed: 0, failed: 0, skipped: 0 };
  const num = (re: RegExp): number => parseInt(output.match(re)?.[1] ?? "0", 10);
  switch (framework) {
    case "node":
      // Node.js test runner: "ℹ pass N" / "ℹ fail N"
      r.passed  = num(/ℹ\s+pass\s+(\d+)/);
      r.failed  = num(/ℹ\s+fail\s+(\d+)/);
      r.skipped = num(/ℹ\s+skipped\s+(\d+)/);
      if (r.passed === 0 && r.failed === 0) { r.passed = num(/^#\s+pass\s+(\d+)/m); r.failed = num(/^#\s+fail\s+(\d+)/m); r.skipped = num(/^#\s+skipped\s+(\d+)/m); }
      if (r.passed === 0 && r.failed === 0) { const line = output.match(/^\s*Tests:?\s+(.+)$/m)?.[1] ?? ""; r.passed = Number(line.match(/(\d+)\s+passed/)?.[1] ?? 0); r.failed = Number(line.match(/(\d+)\s+failed/)?.[1] ?? 0); }
      // Fallback: mocha-style "N passing"
      if (r.passed === 0 && r.failed === 0) {
        r.passed = num(/(\d+)\s+passing/);
        r.failed = num(/(\d+)\s+failing/);
      }
      break;
    case "pytest":
      r.passed  = num(/(\d+)\s+passed/);
      r.failed  = num(/(\d+)\s+failed/);
      r.skipped = num(/(\d+)\s+(?:skipped|deselected)/);
      break;
    case "cargo":
      r.passed = num(/test result:.*?(\d+)\s+passed/);
      r.failed = num(/test result:.*?(\d+)\s+failed/);
      break;
    case "go":
      r.passed = (output.match(/--- PASS/g) ?? []).length;
      r.failed  = (output.match(/--- FAIL/g) ?? []).length;
      if (r.passed === 0 && !output.includes("FAIL\t")) r.passed = 1; // "ok  package  0.1s"
      break;
    case "deno":
      // Deno: "ok | N passed | M failed (Xms)" or "test result: ok. N passed; M failed; ..."
      r.passed  = num(/(\d+)\s+passed/);
      r.failed  = num(/(\d+)\s+failed/);
      if (r.passed === 0 && r.failed === 0) {
        if (/\|\s+\d+\s+passed/.test(output)) {
          r.passed = num(/\|\s+(\d+)\s+passed/);
          r.failed = num(/\|\s+(\d+)\s+failed/);
        }
      }
      break;
    case "bun":
      // Bun: " 5 pass\n 1 fail\n Ran 6 tests"
      r.passed = num(/^\s*(\d+)\s+pass(?:es|ed)?\b/im);
      r.failed = num(/^\s*(\d+)\s+fail(?:s|ed)?\b/im);
      r.skipped = num(/^\s*(\d+)\s+skip(?:s|ped)?\b/im);
      break;

  }
  return r;
}

const RunTests: ToolDef = {
  name: "RunTests",
  description: "跑项目测试套件。完成编码后必须绿才能 agent.done。返回 passed/failed 数+失败详情",
  argsSchema: "project_dir?(str default:cwd)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const dir = resolveWorkspaceToolPath(String(a.project_dir ?? a.dir ?? "."));
    const detected = detectTestCommand(dir);
    if (!detected) {
      return err(
        "Cannot detect test command — no package.json test script, pytest.ini, Cargo.toml, or go.mod found.",
      );
    }
    const { cmd, framework } = detected;
    const winCmd = process.platform === "win32" ? `chcp 65001 >nul 2>nul & ${cmd}` : cmd;
    let rawOutput = "";
    let exitedOk = false;
    try {
      const raw = await execCommand(winCmd, { encoding: "buffer", timeout: Number(a.timeout_ms ?? 180_000), cwd: dir, shell: true as any });
      rawOutput = decodeBuffer(raw as unknown as Buffer);
      exitedOk = true;
    } catch (e: any) {
      rawOutput = [
        e.stdout ? decodeBuffer(e.stdout) : "",
        e.stderr ? decodeBuffer(e.stderr) : "",
      ].filter(Boolean).join("\n");
      exitedOk = false;
    }
    const counts = parseTestCounts(rawOutput, framework);
    if (a.strict === true && (counts.passed === 0 || /\[no test files\]|no tests to run/i.test(rawOutput) || (framework === "go" && !/^(?:ok\s+\S+\s+\d|--- PASS)/m.test(rawOutput)))) return err(`Strict acceptance requires at least one parsed passing test, not just a zero exit code.\n${rawOutput.slice(-4000)}`);
    // If we couldn't parse counts from output, fall back to exit code
    if (counts.passed === 0 && counts.failed === 0) {
      if (exitedOk) counts.passed = 1;
      else counts.failed = 1;
    }
    if (!exitedOk) counts.failed = Math.max(1, counts.failed);
    const status = counts.failed === 0 ? "✅ PASS" : "❌ FAIL";
    const summary =
      `${status}  passed: ${counts.passed}  failed: ${counts.failed}  skipped: ${counts.skipped}\n` +
      `[command] ${cmd}\n\n` +
      `--- Output (last 60 lines) ---\n` +
      rawOutput.split("\n").slice(-60).join("\n");
    const result = summary.slice(0, 10_000);
    return counts.failed === 0 ? ok(result) : { ok: false, output: result };
  },
};

const TypeCheck: ToolDef = {
  name: "TypeCheck",
  description: "静态类型检查（tsc/mypy/go vet）。编辑后立即验证，返回错误列表或 clean",
  argsSchema: "project_dir?(str default:cwd)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const dir = resolveWorkspaceToolPath(String(a.project_dir ?? a.dir ?? "."));

    // TypeScript
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
      try {
        const out = String(await execCommand("npx tsc --noEmit 2>&1", {
          encoding: "utf8", timeout: 60_000, cwd: dir, shell: true as any,
        }));
        return ok(`TypeScript: clean${out.trim() ? `\n${out.slice(0, 2000)}` : ""}`);
      } catch (e: any) {
        const errors = String(e.stdout ?? "") + String(e.stderr ?? "");
        return { ok: false, output: `TypeScript errors:\n${errors.slice(0, 5000)}` };
      }
    }

    // Python mypy
    if (
      fs.existsSync(path.join(dir, "pyproject.toml")) ||
      fs.existsSync(path.join(dir, "setup.py"))
    ) {
      try {
        const out = String(await execCommand("python -m mypy . --ignore-missing-imports 2>&1", {
          encoding: "utf8", timeout: 60_000, cwd: dir, shell: true as any,
        }));
        return ok(`mypy: ${out.slice(0, 2000)}`);
      } catch (e: any) {
        return { ok: false, output: `mypy errors:\n${String(e.stdout ?? "").slice(0, 5000)}` };
      }
    }

    // Go vet
    if (fs.existsSync(path.join(dir, "go.mod"))) {
      try {
        await execCommand("go vet ./...", { encoding: "utf8", timeout: 30_000, cwd: dir, shell: true as any });
        return ok("go vet: clean");
      } catch (e: any) {
        return { ok: false, output: `go vet errors:\n${String(e.stderr ?? "").slice(0, 5000)}` };
      }
    }

    return ok("No type checker detected (no tsconfig.json, pyproject.toml, or go.mod).");
  },
};

const TREE_IGNORE = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__",
  ".next", "coverage", "target", ".cache", "vendor",
]);

function buildDirTree(
  dir: string,
  depth: number,
  indent = "",
  isLast = true,
): string {
  if (depth < 0) return "";
  const name = path.basename(dir);
  const connector = indent ? (isLast ? "└── " : "├── ") : "";
  let result = indent + connector + name + "/\n";
  if (depth === 0) return result;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !TREE_IGNORE.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => {
        // directories first, then files; alphabetical within each group
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch { return result; }
  const childIndent = indent + (isLast ? "    " : "│   ");
  entries.forEach((entry, idx) => {
    const last = idx === entries.length - 1;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result += buildDirTree(child, depth - 1, childIndent, last);
    } else {
      result += childIndent + (last ? "└── " : "├── ") + entry.name + "\n";
    }
  });
  return result;
}

const CodeMap: ToolDef = {
  name: "CodeMap",
  description: "项目结构总览（目录树+关键文件+入口）。改代码前先建立全局认知",
  argsSchema: "dir?(str default:cwd), depth?(int default:2)",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const dir = resolveWorkspaceToolPath(String(a.dir ?? "."));
    const depth = typeof a.depth === "number" ? Math.min(Math.max(a.depth, 1), 4) : 2;
    const tree = buildDirTree(dir, depth);

    const KEY_FILES = [
      "package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml",
      "go.mod", "README.md", ".env.example", "docker-compose.yml", "Makefile",
    ];
    const present = KEY_FILES.filter((f) => fs.existsSync(path.join(dir, f)));

    const parts: string[] = [`[CodeMap] ${dir}  (depth=${depth})\n\n`, tree];

    if (present.length) parts.push(`\nKey files: ${present.join(", ")}`);

    // Peek package.json for name, entry, test script
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string; main?: string; scripts?: Record<string, string>;
      };
      const info = [
        pkg.name && `name="${pkg.name}"`,
        pkg.main && `main="${pkg.main}"`,
        pkg.scripts?.dev && `scripts.dev="${pkg.scripts.dev}"`,
        pkg.scripts?.test && `scripts.test="${pkg.scripts.test}"`,
      ].filter(Boolean);
      if (info.length) parts.push(`\npackage.json: ${info.join("  ")}`);
    } catch { /* no package.json */ }

    return ok(parts.join("").slice(0, 10_000));
  },
};

const FindReferences: ToolDef = {
  name: "FindReferences",
  description: "查找符号（函数/类/变量）在项目中的所有引用位置",
  argsSchema: "symbol(str), dir?(str default:cwd), glob?(str, e.g. '*.ts')",
  needsApproval: false,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const sym = String(a.symbol ?? "");
    if (!sym) return err("missing symbol");
    const dir = String(a.dir ?? ".");
    const glob = a.glob ? `--glob ${JSON.stringify(String(a.glob))}` : "";
    const cmd = `rg -n --word-regexp ${glob} ${JSON.stringify(sym)} ${JSON.stringify(dir)}`
      .replace(/\s+/g, " ")
      .trim();
    try {
      const out = String(await execCommand(cmd, { encoding: "utf8", timeout: 10_000, cwd: toolWorkspace() }));
      return ok(out.slice(0, 20_000) || "(no references found)");
    } catch (e: any) {
      return (
        rgNotFoundResult(e, "Grep") ??
        ok((String(e.stdout ?? "")).slice(0, 20_000) || "(no references found)")
      );
    }
  },
};

// ── rg 缺失检测（导出供测试用）────────────────────────────────────────────────

/** Returns ok:false "rg not found" result when e.code===ENOENT, null otherwise. */
export function rgNotFoundResult(e: unknown, tool: "Glob" | "Grep"): ToolResult | null {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
  const hint = tool === "Glob"
    ? "use Bash with 'find . -name \"pattern\"' (Unix) / 'dir /s' (Windows) instead"
    : "use Bash with 'grep -rn pattern dir' (Unix) / 'findstr' (Windows) instead";
  return err(`ripgrep (rg) not found — install it or ${hint}`);
}

const BrowserControl: ToolDef = {
  name: "BrowserControl",
  description: "基于 Playwright 控制本地浏览器，可导航 URL、截图、提取文本",
  argsSchema: "url(str, 页面URL), action(enum:'navigate'|'screenshot'|'text'), wait_until?(str default:'load'), timeout?(ms default:30000)",
  needsApproval: true,
  roles: new Set(["Leader", "Worker"]),
  async execute(a) {
    const url = String(a.url ?? "");
    const action = String(a.action ?? "navigate");
    const waitUntil = String(a.wait_until ?? "load");
    const timeout = typeof a.timeout === "number" ? a.timeout : 30000;
    if (!url && action !== "screenshot") return err("missing url");
    if (!["navigate", "screenshot", "text"].includes(action)) return err(`unknown action: ${action}`);
    let browser;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      if (action === "navigate") {
        await page.goto(url, { waitUntil: waitUntil as any, timeout });
        return ok(`Navigated to ${url}`);
      }
      if (url) await page.goto(url, { waitUntil: waitUntil as any, timeout });
      if (action === "screenshot") {
        const buf = await page.screenshot({ fullPage: true });
        const b64 = buf.toString("base64");
        return ok(`data:image/png;base64,${b64}`);
      }
      if (action === "text") {
        const text = await page.innerText("body");
        return ok(text.slice(0, 50000));
      }
      return err("unreachable");
    } catch (e: any) {
      return err(`BrowserControl failed: ${e.message ?? e}`);
    } finally {
      if (browser) await browser.close();
    }
  },
};

// ── 注册表（Map 保证 O(1) 查找）─────────────────────────────────────────────

const ALL_TOOLS: ToolDef[] = [SessionRecall, TaskStatus, TaskRetry, TaskReview, TaskPolicy, TaskReconcile, BudgetStatus, WorkspaceStatus, WorkspaceResolve, WorkspacePublish,
  Read, Write, Edit, Bash, Grep, Glob, LS, Think, WebFetch, WebSearch,
  RunTests, TypeCheck, CodeMap, FindReferences, BrowserControl,
];

export const TOOL_REGISTRY = new Map<string, ToolDef>(
  ALL_TOOLS.map((t) => [t.name, t]),
);

export const TOOL_ARG_SPECS: ReadonlyMap<string, ToolArgSpec> = new Map<string, ToolArgSpec>([
  ["SessionRecall", { query: { type: "string" }, limit: { type: "int", required: false, min: 1, max: 20, default: 10 } }],
  ["TaskStatus", { agent: { type: "string", required: false }, task: { type: "string", required: false }, offset: { type: "number", required: false }, limit: { type: "number", required: false } }],
  ["TaskRetry", { task: { type: "string" }, reason: { type: "string" } }],
  ["TaskReview", { task: { type: "string" }, verdict: { type: "enum", values: ["accept", "reject"] }, evidence: { type: "string" }, rationale: { type: "string" } }],
  ["TaskPolicy", { task: { type: "string" }, mode: { type: "enum", values: ["auto", "manual"] } }],
  ["BudgetStatus", {}],
  ["WorkspaceStatus", { task: { type: "string" } }],
  ["WorkspaceResolve", { task: { type: "string" }, path: { type: "string" }, expected: { type: "string" }, choice: { type: "enum", values: ["ours", "theirs"] } }],
  ["WorkspacePublish", { task: { type: "string" } }],
  ["TaskReconcile", { task: { type: "string" }, operation: { type: "string" }, evidence: { type: "string" }, reason: { type: "string" } }],
    ["Read", {
    path: { type: "string", aliases: ["file_path"] },
    task: { type: "string", required: false },
    offset: { type: "int", required: false, min: 0 },
    limit: { type: "int", required: false, min: 1, max: 10_000, default: 200 },
  }],
  ["Write", {
    path: { type: "string", aliases: ["file_path"] },
    content: { type: "string", allowEmpty: true },
  }],
  ["Edit", {
    path: { type: "string", aliases: ["file_path"] },
    old_string: { type: "string", allowEmpty: true },
    new_string: { type: "string", allowEmpty: true },
  }],
  ["Bash", {
    command: { type: "string", aliases: ["cmd"] },
    timeout: { type: "int", required: false, min: 1, max: 300_000, default: 60_000 },
  }],
  ["Grep", {
    pattern: { type: "string" },
    path: { type: "string", required: false, default: "." },
    glob: { type: "string", required: false },
    case_insensitive: { type: "boolean", required: false },
    context: { type: "int", required: false, min: 0, max: 50 },
  }],
  ["Glob", {
    pattern: { type: "string", required: false, default: "**/*" },
    path: { type: "string", required: false, default: "." },
  }],
  ["LS", {
    path: { type: "string", required: false, default: "." },
  }],
  ["Think", {
    thought: { type: "string" },
  }],
  ["WebFetch", {
    url: { type: "string" },
    max_chars: { type: "int", required: false, min: 1, max: 20_000, default: 6_000 },
  }],
  ["WebSearch", {
    query: { type: "string" },
    count: { type: "int", required: false, min: 1, max: 10, default: 5 },
  }],
  ["RunTests", {
    task: { type: "string", required: false },
    project_dir: { type: "string", required: false, aliases: ["dir"], default: "." },
    strict: { type: "boolean", required: false },
    timeout_ms: { type: "int", required: false, min: 1, max: 180000 },
  }],
  ["TypeCheck", {
    task: { type: "string", required: false },
    project_dir: { type: "string", required: false, aliases: ["dir"], default: "." },
  }],
  ["CodeMap", {
    dir: { type: "string", required: false, default: "." },
    depth: { type: "int", required: false, min: 1, max: 4, default: 2 },
  }],
  ["FindReferences", {
    symbol: { type: "string" },
    dir: { type: "string", required: false, default: "." },
    glob: { type: "string", required: false },
  }],
  ["BrowserControl", {
    url: { type: "string", required: false },
    action: { type: "enum", required: false, values: ["navigate", "screenshot", "text"], default: "navigate" },
    wait_until: { type: "string", required: false, default: "load" },
    timeout: { type: "int", required: false, min: 1, max: 120_000, default: 30_000 },
  }],
]);

// ── 公开 API ──────────────────────────────────────────────────────────────────

/** 按角色过滤（借鉴 claude_leack get_tools(simple_mode) 思路） */
export function getToolsForRole(role: AgentRole): ToolDef[] {
  return ALL_TOOLS.filter((t) => t.roles.has(role));
}

const MAX_TOOL_OUTPUT = 12_000; // chars; keep single result small to control context growth

interface ExecuteToolOptions {
  agentId?: string;
  revision?: number;
  callId?: string;
}

/** 执行工具 — 替换原 index.tsx 里的 switch-case */
export async function executeTool(name: string, args: unknown, options: ExecuteToolOptions = {}): Promise<ToolResult> {
  try { if (options.agentId) await waitForSessionControl(options.agentId); }
  catch (error) { return { ok: false, code: "recovery_blocked", output: `Tool blocked until orphan cleanup is confirmed: ${String(error)}` }; }
  if (options.agentId && !sessionJournal().isCurrent(options.agentId, options.revision)) {
    return { ok: false, code: "superseded_revision", output: "Tool blocked: requirement revision is obsolete" };
  }
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) {
    return {
      ok: false,
      output: `Unknown tool "${name}". Available: ${ALL_TOOLS.map((t) => t.name).join(", ")}`,
    };
  }
  const validated = validateToolArgs(name, args);
  if (!validated.ok) {
    recordHealthMetric({
      agent_id: options.agentId ?? "tool-registry",
      event_type: "tool_arg_schema_failed",
      severity: "warn",
      reason: `${name}: ${validated.errors.join("; ")}`,
      meta: {
        tool: name,
        errors: validated.errors,
        args_preview: previewArgs(args),
      },
    });
    return {
      ok: false,
      code: "invalid_args",
      output: [
        `tool_error(invalid_args): ${name} arguments failed schema validation`,
        ...validated.errors.map((error) => `- ${error}`),
        `Expected: ${formatArgSpec(TOOL_ARG_SPECS.get(name) ?? {}, tool.argsSchema)}`,
        "Fix the JSON arguments and retry. After two invalid attempts, hand up with the blocker instead of looping.",
      ].join("\n"),
    };
  }
  try {
    if (options.agentId && options.callId) {
      const journal = sessionJournal(), binding = journal.binding(options.agentId);
      const state = binding && journal.current(binding.conversation);
      const prior = state?.tools[`${options.agentId}:${options.callId}`];
      if (prior && prior.revision === (options.revision ?? binding?.revision)) {
        if (prior.name !== name || JSON.stringify(prior.args) !== JSON.stringify(args)) return { ok: false, code: "call_id_conflict", output: "Tool call ID already belongs to different arguments; use a new ID" };
        if (prior.status === "completed") {
          if (prior.verifiedExecution === false) return { ok: false, code: "unverified_result", output: "A protocol result without a real tool execution cannot count as evidence. Inspect the task; use a fresh tool call ID for an independent check." };
          return { ok: prior.ok ?? true, output: `Previously completed (cached excerpt):\n${prior.output ?? ""}` };
        }
        if (prior.status === "uncertain") return { ok: false, code: "uncertain_effect", output: "Interrupted operation has an unknown outcome. Inspect current files or external state before issuing a deliberate new operation with a new ID; do not blindly replay it." };
      }
    }
    if (options.agentId) consumeSessionTool(options.agentId, name);
    const operation = options.agentId ? beginTaskOperation(options.agentId, options.callId, name, validated.args) : {};
    if (operation.blocked) return { ok: false, code: "task_control_blocked", output: operation.blocked };
    if (operation.cached) return { ok: true, output: operation.cached };
    const result = await withToolCancellation(options.agentId, () => withWorkspace(options.agentId, name, validated.args, () => tool.execute({ ...validated.args, __sessionAgent: options.agentId })));
    if (options.agentId && operation.key) finishTaskOperation(options.agentId, operation.key, name, validated.args, result);
    if (options.agentId) {
      const journal = sessionJournal(), binding = journal.binding(options.agentId);
      if (binding) journal.append("tool.output", binding.conversation, options.agentId, options.revision ?? binding.revision, { name, id: options.callId, ok: result.ok, output: result.output });
    }
    return { ...result, output: middleTruncate(result.output, MAX_TOOL_OUTPUT) };
  } catch (e: any) {
    return { ok: false, code: e.message?.includes("SESSION_BUDGET") ? "session_budget_exhausted" : undefined, output: `Error in ${name}: ${e.message?.slice(0, 500) ?? "unknown"}` };
  }
}

// Bash commands that modify filesystem or run installs/git writes — require approval
const BASH_DESTRUCTIVE =
  /(?:^|[;&|`]|\$\()\s*(?:rm|del|rmdir|rd|mv|cp|move|copy|mkdir|md|touch|chmod|chown|tee|git\s+(?:reset|checkout|branch\s+-[Dd]|stash)|npm\s+(?:install|run|ci)|yarn\s+add|pip\s+install|apt|brew|choco)|\s(?:>>?)\s*[^&>|;\s]/i;

/**
 * 检查工具是否需要审批（注册表是权威来源，防止 agent 篡改 needs_approval）
 * Bash 例外：根据命令内容判断是否具有破坏性，只读命令自动放行。
 */
export function toolNeedsApproval(name: string, args?: unknown): boolean {
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) return true; // 未知工具默认需要审批
  if (name === "Bash" && args && typeof args === "object" && args !== null) {
    const cmd = String((args as Record<string, unknown>).command ?? (args as Record<string, unknown>).cmd ?? "");
    return BASH_DESTRUCTIVE.test(cmd);
  }
  return tool.needsApproval;
}

/** 生成注入 system prompt 的工具表格 */
export function buildToolSchemaBlock(role: AgentRole): string {
  const tools = getToolsForRole(role);
  const rows = tools.map((t) =>
    `| ${t.name.padEnd(5)} | ${formatArgSpec(TOOL_ARG_SPECS.get(t.name) ?? {}, t.argsSchema).padEnd(52)} | ${t.needsApproval ? "**true** " : "false    "} | ${t.description} |`
  );
  const header = [
    "| 工具  | 参数                                                 | needs_approval | 说明 |",
    "|-------|------------------------------------------------------|----------------|------|",
  ].join("\n");

  const EXAMPLES: Record<string, string> = {
    Read:  `{"path":"src/pm/ProcessManager.ts","limit":100}`,
    Write: `{"path":"src/utils/helper.ts","content":"export function foo() {}"}`,
    Edit:  `{"path":"src/index.ts","old_string":"const x = 1","new_string":"const x = 2"}`,
    Bash:  `{"command":"npm run test 2>&1 | head -50"}`,
    Grep:  `{"pattern":"preCheckSpawn","path":"src","glob":"*.ts","context":3}`,
    Glob:  `{"pattern":"src/**/*.ts"}`,
    LS:    `{"path":"src"}`,
    Think:     `{"thought":"I should read the config first before deciding which files to edit"}`,
    WebFetch:      `{"url":"https://example.com/docs","max_chars":4000}`,
    WebSearch:     `{"query":"feishu bot nodejs SDK","count":5}`,
    RunTests:      `{"project_dir":"."}`,
    TypeCheck:     `{"project_dir":"."}`,
    CodeMap:       `{"dir":".","depth":2}`,
    FindReferences:`{"symbol":"createAggregator","dir":"src","glob":"*.ts"}`,
  };
  const examples = tools
    .filter((t) => EXAMPLES[t.name])
    .map((t) => `- ${t.name}: ${EXAMPLES[t.name]}`);

  return `${header}\n${rows.join("\n")}\n\nargs 示例：\n${examples.join("\n")}`;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function ok(output: string): ToolResult  { return { ok: true,  output }; }
function err(output: string): ToolResult { return { ok: false, output }; }

type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function validateToolArgs(name: string, args: unknown): ValidationResult {
  const spec = TOOL_ARG_SPECS.get(name);
  if (!spec) {
    return { ok: true, args: isPlainRecord(args) ? args : {} };
  }
  if (!isPlainRecord(args)) {
    return { ok: false, errors: ["args must be a JSON object"] };
  }

  const errors: string[] = [];
  const normalized: Record<string, unknown> = {};
  const allowed = new Set<string>();
  for (const [field, rule] of Object.entries(spec)) {
    allowed.add(field);
    for (const alias of rule.aliases ?? []) allowed.add(alias);
  }

  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) errors.push(`unknown field "${key}"`);
  }

  for (const [field, rule] of Object.entries(spec)) {
    const found = readField(args, field, rule.aliases);
    if (!found.exists) {
      if (rule.required !== false) {
        errors.push(`missing required field "${field}"`);
      }
      continue;
    }

    const value = found.value;
    if (value === undefined || value === null) {
      if (rule.required === false) continue;
      errors.push(`field "${field}" is required`);
      continue;
    }
    const checked = validateValue(field, value, rule);
    if (checked.ok) normalized[field] = checked.value;
    else errors.push(checked.error);
  }

  return errors.length ? { ok: false, errors } : { ok: true, args: normalized };
}

function validateValue(
  field: string,
  value: unknown,
  rule: ToolArgField,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (rule.type === "string") {
    if (typeof value !== "string") return { ok: false, error: `field "${field}" must be string` };
    if (!rule.allowEmpty && value.trim() === "") return { ok: false, error: `field "${field}" must be non-empty string` };
    return { ok: true, value };
  }
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") return { ok: false, error: `field "${field}" must be boolean` };
    return { ok: true, value };
  }
  if (rule.type === "int") {
    if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, error: `field "${field}" must be integer` };
    return validateNumberRange(field, value, rule);
  }
  if (rule.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, error: `field "${field}" must be number` };
    return validateNumberRange(field, value, rule);
  }
  if (rule.type === "enum") {
    if (typeof value !== "string") return { ok: false, error: `field "${field}" must be string enum` };
    if (!rule.values?.includes(value)) {
      return { ok: false, error: `field "${field}" must be one of: ${(rule.values ?? []).join(", ")}` };
    }
    return { ok: true, value };
  }
  return { ok: false, error: `field "${field}" has unsupported schema type` };
}

function validateNumberRange(
  field: string,
  value: number,
  rule: ToolArgField,
): { ok: true; value: number } | { ok: false; error: string } {
  if (rule.min !== undefined && value < rule.min) return { ok: false, error: `field "${field}" must be >= ${rule.min}` };
  if (rule.max !== undefined && value > rule.max) return { ok: false, error: `field "${field}" must be <= ${rule.max}` };
  return { ok: true, value };
}

function readField(
  args: Record<string, unknown>,
  field: string,
  aliases: readonly string[] = [],
): { exists: true; value: unknown } | { exists: false } {
  if (Object.prototype.hasOwnProperty.call(args, field)) return { exists: true, value: args[field] };
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(args, alias)) return { exists: true, value: args[alias] };
  }
  return { exists: false };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatArgSpec(spec: ToolArgSpec, fallback: string): string {
  const entries = Object.entries(spec);
  if (!entries.length) return fallback;
  return entries.map(([name, rule]) => {
    const optional = rule.required === false ? "?" : "";
    const type = rule.type === "enum"
      ? `enum:${(rule.values ?? []).map((v) => `'${v}'`).join("|")}`
      : rule.type;
    const suffix = rule.default !== undefined ? ` default:${String(rule.default)}` : "";
    return `${name}${optional}(${type}${suffix})`;
  }).join(", ");
}

function previewArgs(args: unknown): string {
  try {
    return JSON.stringify(args)?.slice(0, 500) ?? "";
  } catch {
    return String(args).slice(0, 500);
  }
}

function middleTruncate(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 2);
  const tail  = max - head;
  const skipped = s.slice(head, s.length - tail);
  const skippedLines = (skipped.match(/\n/g)?.length ?? 0);
  return s.slice(0, head)
    + `\n\n[... ${skipped.length} chars / ~${skippedLines} lines truncated ...]\n\n`
    + s.slice(-tail);
}
