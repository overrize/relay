/**
 * 场景判定类型（plans/00-scenario-anchor）。
 * "任务是否完成 / 产物长什么样 / 哪些节点必须问人" 表达为代码可执行的规则，
 * 而非文档口号。runner 可注入，测试不依赖真实命令。
 */

/** 一条验收判据：可执行命令 + 通过所需退出码（客观信号，非 LLM 自评） */
export interface AcceptanceCheck {
  name: string;
  run: string;            // 可执行命令，如 "npm test"
  expectExitCode: number; // 通过所需退出码，通常 0
}

/** 一次验收评估的结果（逐 check 记录退出码） */
export interface AcceptanceResult {
  passed: boolean;
  checks: { name: string; passed: boolean; exitCode: number }[];
}

/** 产物形态：任务"完成"时必须存在的交付物 */
export interface ArtifactSpec {
  kind: "git-commit" | "report-file";
  requiredFields: string[]; // 如 ["diff", "acceptance", "path"]
}

/** 必须停下来问人的节点（HITL 触发时机） */
export interface HitlTrigger { id: string; when: string; }

/** 一个场景 = 验收判据 + 产物形态 + HITL 时机 的完整定义 */
export interface Scenario {
  name: string;
  acceptanceChecks: AcceptanceCheck[];
  artifact: ArtifactSpec;
  hitlTriggers: HitlTrigger[];
}
