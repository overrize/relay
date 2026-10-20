import { describe, it } from "node:test";
import { strict as assert } from "node:assert/strict";
import { shouldSuppress } from "../../feishu/outbound/SuppressFilter.js";
import { decideFormat } from "../../feishu/outbound/FormatDecider.js";
import { sanitize } from "../../feishu/outbound/Sanitizer.js";
import type { OutboundMsg, OutboundContext } from "../../feishu/outbound/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const msg = (overrides: Partial<OutboundMsg> = {}): OutboundMsg => ({
  text: "hello",
  _fallback: false,
  agentId: "pm-test",
  ...overrides,
});

const ctx = (overrides: Partial<OutboundContext> = {}): OutboundContext => ({
  pmId: "pm-test",
  conversationMode: true,
  hasActiveChildren: false,
  ...overrides,
});

// ─── SuppressFilter ──────────────────────────────────────────────────────────

describe("SuppressFilter", () => {
  it("passes normal message", () => {
    assert.equal(shouldSuppress(msg({ text: "分析完成，请查收报告。" }), ctx()), null);
  });

  it("suppresses _fallback messages", () => {
    const r = shouldSuppress(msg({ _fallback: true, text: "任何文本" }), ctx());
    assert.match(r!, /fallback/);
  });

  it("suppresses spawn-failure noise", () => {
    const r = shouldSuppress(msg({ text: "任务已完成，无需响应" }), ctx());
    assert.match(r!, /noise/);
  });

  it("suppresses spawn rejected noise", () => {
    const r = shouldSuppress(msg({ text: "spawn rejected: ID 冲突" }), ctx());
    assert.match(r!, /noise/);
  });

  it("suppresses intermediate progress when children are active", () => {
    const r = shouldSuppress(
      msg({ text: "已派 tl-01 处理，稍后汇报" }),
      ctx({ hasActiveChildren: true }),
    );
    assert.match(r!, /children/);
  });

  it("allows substantive PM replies while children are active", () => {
    assert.equal(shouldSuppress(msg({ text: "SSO 方案可以保留邮箱登录，我会调整任务。" }), ctx({ hasActiveChildren: true })), null);
  });

  it("does NOT suppress when no active children", () => {
    const r = shouldSuppress(
      msg({ text: "分析完成，请查收报告。" }),
      ctx({ hasActiveChildren: false }),
    );
    assert.equal(r, null);
  });

  it("does NOT suppress in non-conversationMode even with children", () => {
    const r = shouldSuppress(
      msg({ text: "正在处理" }),
      ctx({ hasActiveChildren: true, conversationMode: false }),
    );
    assert.equal(r, null);
  });
});

// ─── FormatDecider ───────────────────────────────────────────────────────────

describe("FormatDecider", () => {
  it("short text with no hint → text", () => {
    assert.equal(decideFormat("你好"), "text");
  });

  it("PM hint=document → document", () => {
    assert.equal(decideFormat("short", "document"), "document");
  });

  it(">800 chars → document", () => {
    assert.equal(decideFormat("x".repeat(801)), "document");
  });

  it("LaTeX \\( \\) → document", () => {
    assert.equal(decideFormat("force: \\( F = ma \\)"), "document");
  });

  it("LaTeX $$ → document", () => {
    assert.equal(decideFormat("$$E=mc^2$$"), "document");
  });

  it("LaTeX \\frac → document", () => {
    assert.equal(decideFormat("ratio \\frac{a}{b}"), "document");
  });

  it("LaTeX \\tau → document (Chinese engineering report)", () => {
    assert.equal(decideFormat("扭矩 \\tau = 50 Nm"), "document");
  });

  it("markdown table → document", () => {
    const table = "| col1 | col2 |\n|------|------|\n| a    | b    |";
    assert.equal(decideFormat(table), "document");
  });

  it("two or more ## headings → document", () => {
    const md = "## 一、概述\n内容\n## 二、分析\n内容";
    assert.equal(decideFormat(md), "document");
  });

  it("single heading → text (not enough to force card)", () => {
    assert.equal(decideFormat("## 标题\n短文本"), "text");
  });

  it("two code fences → document", () => {
    const code = "```ts\nconsole.log(1)\n```\n\n```ts\nconsole.log(2)\n```";
    assert.equal(decideFormat(code), "document");
  });

  it("plain conversational reply stays text", () => {
    assert.equal(decideFormat("好的，我来处理这个任务。"), "text");
  });
});

// ─── Sanitizer ───────────────────────────────────────────────────────────────

describe("Sanitizer", () => {
  it("unescapes \\n in text mode", () => {
    assert.equal(sanitize("line1\\nline2", "text"), "line1\nline2");
  });

  it("unescapes \\n in document mode", () => {
    assert.equal(sanitize("line1\\nline2", "document"), "line1\nline2");
  });

  // Regression: Windows paths contain \t / \n as real separators — unescaping them
  // turned "\tui-ink" into a TAB and corrupted the path (broke image auto-send).
  it("preserves Windows paths (does not unescape \\t inside them)", () => {
    const p = "E:\\spawn-work\\tui-ink\\humanoid_control_architecture.png";
    for (const fmt of ["text", "document"] as const) {
      const out = sanitize(`找到了：${p}`, fmt);
      assert.ok(out.includes(p), `${fmt}: path must survive intact`);
      assert.ok(!out.includes("\t"), `${fmt}: no TAB injected into the path`);
    }
    // 真正的转义序列仍要还原（路径之外）
    assert.equal(sanitize(`${p}\\n下一行`, "document"), `${p}\n下一行`);
  });

  it("strips **bold** in text mode", () => {
    assert.equal(sanitize("**bold** text", "text"), "bold text");
  });

  it("strips # heading in text mode", () => {
    assert.equal(sanitize("## Title\nBody", "text"), "Title\nBody");
  });

  it("strips `inline code` in text mode", () => {
    assert.equal(sanitize("use `foo()` here", "text"), "use foo() here");
  });

  it("strips [link](url) in text mode", () => {
    assert.equal(sanitize("[click here](https://example.com)", "text"), "click here");
  });

  it("replaces fenced code block with placeholder in text mode", () => {
    const result = sanitize("```ts\nconst x = 1\n```", "text");
    assert.equal(result, "[代码]");
  });

  it("preserves markdown in document mode", () => {
    const md = "## 标题\n**重要**\n`code`";
    assert.equal(sanitize(md, "document"), md);
  });

  it("still unescapes in document mode", () => {
    assert.equal(sanitize("line1\\nline2\\n**bold**", "document"), "line1\nline2\n**bold**");
  });
});
