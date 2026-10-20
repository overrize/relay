// registry.test.ts
// Covers: toolNeedsApproval, getToolsForRole, executeTool basics, deleteAgentMemory

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// spawnSync accepts shell: boolean (execSync only accepts shell: string).
// Pass the full command as a string — do NOT pass args as a separate array
// when shell:true, because the shell receives them as $0/$1 (not rg arguments).
const hasRg = (() => {
  const r = spawnSync("rg --version", [], { stdio: "ignore", shell: true });
  return !r.error && r.status === 0;
})();

import {
  buildToolSchemaBlock,
  executeTool,
  getToolsForRole,
  toolNeedsApproval,
  validateToolArgs,
} from "../tools/registry.js";
import { HealthMetricsStore, setHealthMetricsStoreForTests } from "../runtime/HealthMetrics.js";
import {
  createMemory, saveMemory, deleteAgentMemory,
  startSession, appendMessage, loadMessages, loadSessions,
  memoryPath, messagesPath, sessionsPath, ensureMemoryDir, MAX_SESSIONS,
} from "../memory/MemoryStore.js";

let tmpDir: string;
let origCwd: string;

before(() => {
  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-registry-"));
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── toolNeedsApproval ────────────────────────────────────────────────────────

describe("toolNeedsApproval — read-only tools", () => {
  it("Read / Write / Edit / Think → false", () => {
    assert.equal(toolNeedsApproval("Read"),  false);
    assert.equal(toolNeedsApproval("Write"), false);
    assert.equal(toolNeedsApproval("Edit"),  false);
    assert.equal(toolNeedsApproval("Think"), false);
  });

  it("unknown tool → true (safe default)", () => {
    assert.equal(toolNeedsApproval("NoSuchTool"), true);
  });
});

describe("toolNeedsApproval — Bash command classification", () => {
  it("read-only commands → false", () => {
    assert.equal(toolNeedsApproval("Bash", { command: "cat package.json" }), false);
    assert.equal(toolNeedsApproval("Bash", { command: "ls src/" }), false);
    assert.equal(toolNeedsApproval("Bash", { command: "node --version" }), false);
  });

  it("destructive commands → true", () => {
    assert.equal(toolNeedsApproval("Bash", { command: "rm -rf /tmp/x" }),     true);
    // git commit/push intentionally removed from approval list so PM/TL can push autonomously
    assert.equal(toolNeedsApproval("Bash", { command: "git commit -m msg" }), false);
    assert.equal(toolNeedsApproval("Bash", { command: "npm install lodash" }), true);
    assert.equal(toolNeedsApproval("Bash", { command: "echo x >> file.txt" }), true);
  });
});

// ── getToolsForRole ──────────────────────────────────────────────────────────

describe("getToolsForRole", () => {
  it("only Leaders receive task retry, policy and independent review controls", () => {
    const leader = getToolsForRole("Leader").map(t => t.name).sort();
    const worker = getToolsForRole("Worker").map(t => t.name).sort();
    assert.deepEqual(leader.filter((name) => !["TaskRetry", "TaskReview", "TaskPolicy", "TaskReconcile", "WorkspaceResolve", "WorkspacePublish"].includes(name)), worker);
    for (const name of ["TaskRetry", "TaskReview", "TaskPolicy", "TaskReconcile", "WorkspaceResolve", "WorkspacePublish"]) assert.ok(leader.includes(name) && !worker.includes(name));
  });

  it("includes all core tools", () => {
    const names = getToolsForRole("Leader").map(t => t.name);
    for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "LS", "Think"]) {
      assert.ok(names.includes(t), `Missing: ${t}`);
    }
  });
});

// ── tool argument schema ──────────────────────────────────────────────────────

describe("tool argument schema", () => {
  it("normalizes aliases without changing runtime defaults", () => {
    const result = validateToolArgs("Read", { file_path: "a.txt" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.args, { path: "a.txt" });
    }
  });

  it("rejects non-object, unknown, and wrongly typed arguments", () => {
    assert.deepEqual(validateToolArgs("Read", null), {
      ok: false,
      errors: ["args must be a JSON object"],
    });
    const result = validateToolArgs("Read", { path: "a.txt", limit: "10", extra: true });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.includes('unknown field "extra"'));
      assert.ok(result.errors.includes('field "limit" must be integer'));
    }
  });

  it("executeTool emits invalid_args result and HealthMetric before tool execution", async () => {
    const store = new HealthMetricsStore(fs.mkdtempSync(path.join(os.tmpdir(), "registry-health-")));
    setHealthMetricsStoreForTests(store);
    try {
      const r = await executeTool("Read", { path: 123 }, { agentId: "worker-schema" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "invalid_args");
      assert.ok(r.output.includes("tool_error(invalid_args)"));
      assert.ok(r.output.includes('field "path" must be string'));

      const metrics = store.readMetrics();
      assert.equal(metrics.length, 1);
      assert.equal(metrics[0]!.event_type, "tool_arg_schema_failed");
      assert.equal(metrics[0]!.agent_id, "worker-schema");
      assert.equal(metrics[0]!.meta?.tool, "Read");
    } finally {
      setHealthMetricsStoreForTests(null);
    }
  });

  it("buildToolSchemaBlock renders parameter text from structured specs", () => {
    const block = buildToolSchemaBlock("Leader");
    assert.ok(block.includes("path(string), task?(string), offset?(int), limit?(int default:200)"));
    assert.ok(block.includes("action?(enum:'navigate'|'screenshot'|'text' default:navigate)"));
  });
});

// ── executeTool — Read ───────────────────────────────────────────────────────

describe("executeTool — Read", () => {
  it("reads an existing file with line numbers", async () => {
    const f = path.join(tmpDir, "read-test.txt");
    fs.writeFileSync(f, "alpha\nbeta\ngamma");
    const r = await executeTool("Read", { path: f });
    assert.ok(r.ok);
    assert.ok(r.output.includes("alpha"));
    assert.ok(r.output.includes("1\t"));
  });

  it("returns ok:false for missing file", async () => {
    const r = await executeTool("Read", { path: path.join(tmpDir, "missing.txt") });
    assert.equal(r.ok, false);
  });

  it("rejects paths outside workspace and temp roots", async () => {
    const outside = path.parse(tmpDir).root;
    const r = await executeTool("Read", { path: outside });
    assert.equal(r.ok, false);
    assert.match(r.output, /Path rejected|EISDIR/);
  });
});

// ── executeTool — Write ──────────────────────────────────────────────────────

describe("executeTool — Write", () => {
  it("creates file with content", async () => {
    const f = path.join(tmpDir, "write-test.txt");
    const r = await executeTool("Write", { path: f, content: "hello world" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "hello world");
  });

  it("creates intermediate directories", async () => {
    const f = path.join(tmpDir, "deep", "dir", "file.txt");
    const r = await executeTool("Write", { path: f, content: "deep" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "deep");
  });
});

// ── executeTool — Edit ───────────────────────────────────────────────────────

describe("executeTool — Edit", () => {
  it("replaces a unique string", async () => {
    const f = path.join(tmpDir, "edit-test.txt");
    fs.writeFileSync(f, "foo BAR baz");
    const r = await executeTool("Edit", { path: f, old_string: "BAR", new_string: "QUX" });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(f, "utf8"), "foo QUX baz");
  });

  it("errors when old_string not found", async () => {
    const f = path.join(tmpDir, "edit-notfound.txt");
    fs.writeFileSync(f, "foo bar");
    const r = await executeTool("Edit", { path: f, old_string: "MISSING", new_string: "x" });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("not found"));
  });

  it("errors when old_string is ambiguous (multiple matches)", async () => {
    const f = path.join(tmpDir, "edit-dup.txt");
    fs.writeFileSync(f, "foo foo foo");
    const r = await executeTool("Edit", { path: f, old_string: "foo", new_string: "bar" });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("3 times"));
  });
});

// ── executeTool — Think ──────────────────────────────────────────────────────

describe("executeTool — Think", () => {
  it("always returns ok:true", async () => {
    const r = await executeTool("Think", { thought: "check the config before editing" });
    assert.ok(r.ok);
  });
});

// ── executeTool — Bash banned commands ──────────────────────────────────────

describe("executeTool — Bash banned commands", () => {
  for (const banned of ["ssh", "nc", "telnet", "ncat", "rsync"]) {
    it(`blocks ${banned}`, async () => {
      const r = await executeTool("Bash", { command: `${banned} example.com` });
      assert.equal(r.ok, false);
      assert.ok(r.output.toLowerCase().includes("banned"));
    });
  }
});

// ── executeTool — unknown tool ───────────────────────────────────────────────

describe("executeTool — unknown tool", () => {
  it("returns error listing available tools", async () => {
    const r = await executeTool("NoSuchTool", {});
    assert.equal(r.ok, false);
    assert.ok(r.output.includes("Unknown tool"));
    assert.ok(r.output.includes("Read"));
  });
});

// ── executeTool — Grep (requires rg) ─────────────────────────────────────────

describe("executeTool — Grep", { skip: !hasRg ? "ripgrep not installed" : false }, () => {
  it("finds pattern in file", async () => {
    const f = path.join(tmpDir, "grep-src.ts");
    fs.writeFileSync(f, "export function hello() {}\nexport function world() {}");
    const r = await executeTool("Grep", { pattern: "hello", path: tmpDir });
    assert.ok(r.ok);
    assert.ok(r.output.includes("hello"));
  });

  it("returns (no matches) for absent pattern", async () => {
    const r = await executeTool("Grep", { pattern: "ZZZNOMATCH_UNIQUE", path: tmpDir });
    assert.ok(r.ok);
    assert.ok(r.output.includes("no matches"));
  });

  it("case_insensitive flag works", async () => {
    const f = path.join(tmpDir, "grep-case.ts");
    fs.writeFileSync(f, "HELLO WORLD");
    const r = await executeTool("Grep", { pattern: "hello", path: tmpDir, case_insensitive: true });
    assert.ok(r.ok);
    assert.ok(r.output.includes("HELLO"));
  });
});

// ── executeTool — Glob (requires rg) ─────────────────────────────────────────

describe("executeTool — Glob", { skip: !hasRg ? "ripgrep not installed" : false }, () => {
  it("matches files by extension pattern", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "bar.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "baz.json"), "{}");
    const r = await executeTool("Glob", { pattern: "**/*.ts", path: tmpDir });
    assert.ok(r.ok);
    assert.ok(r.output.includes("foo.ts"));
    assert.ok(r.output.includes("bar.ts"));
    assert.ok(!r.output.includes("baz.json"), ".json should not match **/*.ts");
  });

  it("returns (no files) when pattern matches nothing", async () => {
    const r = await executeTool("Glob", { pattern: "**/*.xyz_unique", path: tmpDir });
    assert.ok(r.ok);
    assert.ok(r.output.includes("no files"));
  });
});

// ── Session-based message history ───────────────────────────────────────────

describe("session history — all messages preserved within session", () => {
  it("startSession creates a new session entry", () => {
    startSession("sess-basic", "abc1234");
    const sessions = loadSessions("sess-basic");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_hash, "abc1234");
    assert.equal(sessions[0].messages.length, 0);
  });

  it("appendMessage keeps ALL messages within a session (no truncation)", () => {
    startSession("sess-full", "hash01");
    const N = 20;
    for (let i = 0; i < N; i++) {
      appendMessage("sess-full", { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}`, ts: i });
    }
    const msgs = loadMessages("sess-full");
    assert.equal(msgs.length, N, "all messages must be preserved within a session");
    assert.equal(msgs[0].content, "msg-0");
    assert.equal(msgs[N - 1].content, `msg-${N - 1}`);
  });

  it(`evicts oldest session when more than MAX_SESSIONS (${MAX_SESSIONS}) start`, () => {
    const id = "sess-evict";
    for (let s = 0; s < MAX_SESSIONS + 2; s++) {
      startSession(id, `hash-${s}`);
      appendMessage(id, { role: "user", content: `session-${s}-msg`, ts: s });
    }
    const sessions = loadSessions(id);
    assert.equal(sessions.length, MAX_SESSIONS, "must not exceed MAX_SESSIONS");
    assert.equal(sessions[0].session_hash, "hash-2", "oldest two sessions evicted");
    assert.equal(sessions[MAX_SESSIONS - 1].session_hash, `hash-${MAX_SESSIONS + 1}`);
  });

  it("loadMessages returns most recent session's messages only", () => {
    startSession("sess-load", "s1");
    appendMessage("sess-load", { role: "user", content: "from-s1", ts: 1 });
    startSession("sess-load", "s2");
    appendMessage("sess-load", { role: "user", content: "from-s2", ts: 2 });

    const msgs = loadMessages("sess-load");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, "from-s2", "should return current session only");
  });

  it("deleteAgentMemory removes .json but keeps .sessions.json for resume", () => {
    ensureMemoryDir();
    const mem = createMemory({ agentId: "sess-del", agentType: "LEADER",
      parentChain: ["pm"], depth: 1, model: "deepseek-v4-pro", roleName: "Leader" });
    saveMemory("sess-del", mem);
    startSession("sess-del", mem.session_hash!);
    appendMessage("sess-del", { role: "user", content: "task", ts: 1 });

    deleteAgentMemory("sess-del");

    assert.equal(fs.existsSync(memoryPath("sess-del")),    false, ".json deleted");
    assert.ok   (fs.existsSync(sessionsPath("sess-del")),         ".sessions.json kept for resume");
  });
});

// ── deleteAgentMemory ────────────────────────────────────────────────────────

describe("deleteAgentMemory — agent.done cleanup", () => {
  it("removes working-set .json but keeps .sessions.json for resume", () => {
    ensureMemoryDir();
    const mem = createMemory({
      agentId: "tl-cleanup-test",
      agentType: "LEADER",
      parentChain: ["pm"],
      depth: 1,
      model: "deepseek-v4-pro",
      roleName: "Leader",
    });
    saveMemory("tl-cleanup-test", mem);
    startSession("tl-cleanup-test", mem.session_hash!);
    appendMessage("tl-cleanup-test", { role: "user", content: "task done", ts: Date.now() });

    assert.ok(fs.existsSync(memoryPath("tl-cleanup-test")),    ".json must exist before cleanup");
    assert.ok(fs.existsSync(sessionsPath("tl-cleanup-test")), ".sessions.json must exist before cleanup");

    deleteAgentMemory("tl-cleanup-test");

    assert.equal(fs.existsSync(memoryPath("tl-cleanup-test")),   false, ".json deleted");
    assert.ok   (fs.existsSync(sessionsPath("tl-cleanup-test")),        ".sessions.json kept for resume");
  });

  it("is idempotent — no throw when files already gone", () => {
    assert.doesNotThrow(() => deleteAgentMemory("never-existed-agent"));
  });
});
