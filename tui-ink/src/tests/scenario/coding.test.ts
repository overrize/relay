/**
 * 编码场景规则测试（plans/00-scenario-anchor）。
 * 验收判据 = 可执行命令 + 退出码；runner 注入，不依赖真实命令。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codingScenario, evaluateAcceptance } from "../../scenario/coding.js";

test("coding scenario has test/tsc/lint acceptance checks", () => {
  const names = codingScenario.acceptanceChecks.map((c) => c.name);
  assert.deepEqual(names.sort(), ["lint", "test", "typecheck"]);
});

test("acceptance fails if any check exits non-zero", async () => {
  const fakeRunner = async (cmd: string) => (cmd.includes("test") ? 1 : 0);
  const res = await evaluateAcceptance(codingScenario.acceptanceChecks, fakeRunner);
  assert.equal(res.passed, false);
  assert.equal(res.checks.find((c) => c.name === "test")?.passed, false);
});

test("acceptance passes only when all checks exit 0", async () => {
  const res = await evaluateAcceptance(codingScenario.acceptanceChecks, async () => 0);
  assert.equal(res.passed, true);
});
