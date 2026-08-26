# 主场景定义：编码开发

> 与 `src/scenario/coding.ts` 逐条一致（代码是权威，本文档是人类可读镜像）。
> 验收/产物/HITL 均为**可判定规则**，禁止"由 agent 判断"。

## 验收判据（任务"完成"的客观信号，由系统跑命令读退出码判定）
- test: `npm test` 退出码 0
- typecheck: `npm run typecheck` 退出码 0
- lint: `npm run lint` 退出码 0
（三者全 0 才算完成；任一非 0 则 done 被拒，转 handup）

## 产物形态
- kind: git-commit
- 必含字段: diff（改了什么）、acceptance（验收结果）、path（产物位置/worktree）

## HITL 触发时机
- plan-approval: PM 提出任务拆解方案后
- destructive-op: 破坏性操作执行前
- final-review: 交付前

## 量化目标线（阶段 2 出口用）
- 主场景任务一次通过验收率 ≥ 70%（在 E2E 场景集上统计）
