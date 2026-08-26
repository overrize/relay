/**
 * 编码场景（主场景）的三组可判定规则：验收判据 / 产物形态 / HITL 时机。
 * 对应文档 docs/SCENARIO.md；判据以退出码为准，禁止"由 agent 判断"。
 */
import type { Scenario, AcceptanceCheck, AcceptanceResult } from "./types.js";

export const codingScenario: Scenario = {
  name: "coding",
  acceptanceChecks: [
    { name: "test", run: "npm test", expectExitCode: 0 },
    { name: "typecheck", run: "npm run typecheck", expectExitCode: 0 },
    { name: "lint", run: "npm run lint", expectExitCode: 0 },
  ],
  artifact: { kind: "git-commit", requiredFields: ["diff", "acceptance", "path"] },
  hitlTriggers: [
    { id: "plan-approval", when: "PM 提出任务拆解方案后" },
    { id: "destructive-op", when: "破坏性操作执行前" },
    { id: "final-review", when: "交付前" },
  ],
};

/** 当前激活场景（默认=编码；研究场景保留接口，后续接入） */
export function getActiveScenario(): Scenario { return codingScenario; }

/**
 * 跑一组验收判据并汇总结果。
 * @param runner 命令执行器（注入以便测试；真实实现可包 spawn/exit code 捕获）
 */
export async function evaluateAcceptance(
  checks: AcceptanceCheck[],
  runner: (cmd: string) => Promise<number>,
): Promise<AcceptanceResult> {
  const results: { name: string; passed: boolean; exitCode: number }[] = [];
  for (const c of checks) {
    const exitCode = await runner(c.run);
    results.push({ name: c.name, passed: exitCode === c.expectExitCode, exitCode });
  }
  return { passed: results.every((r) => r.passed), checks: results };
}
