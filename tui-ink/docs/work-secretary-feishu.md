# Relay / OmO 工作秘书与飞书记录方案

2026-10-21 调查。状态：首版代码与配置入口已实现，见 [部署和验证说明](work-secretary-setup.md)；真实飞书租户仍需管理员配置后联调。用户决定：Relay 扩展已有秘书；OmO Native 增加独立秘书 agent；两端共用飞书记录。

## 订阅能力不能替代工作记录系统

“leader”在这里指人的团队负责人，不是模型内的 Leader 角色。购买团队席位、管理员用量统计、合规内容访问、业务日报是四种不同能力。团队负责人通常还需要被明确授予相应权限；订阅也不自动授予外部客户端的原始会话访问权。

| 产品 | 官方已确认的内容/管理能力 | 对本项目的意义 |
| --- | --- | --- |
| ChatGPT Business / Enterprise | Business 的组织管理不能当成自动接管私人对话；Enterprise/Edu 合规接口支持其覆盖的数据，需相应管理员密钥和敏感范围权限，精确覆盖依产品/端点而异 | 采用/费用分析与工作成果不同；不以合规接口做员工绩效评分，也不假定能覆盖 OmO/Relay |
| Claude Team / Enterprise | 两者 Primary Owner 可导出组织 conversation/user 数据；Enterprise 提供程序化 Compliance API，Primary Owner 启用，普通 Admin 不能启用 | Team 的手动导出不是实时日报流；Enterprise 能作为经授权的补充来源 |
| Microsoft 365 Copilot | Graph interaction export 支持记录到该服务的企业提示和响应，需要 Copilot 许可与应用权限 AiEnterpriseInteraction.Read.All；并非所有体验均覆盖，个人账号不在范围内 | 可接企业工作来源，仍需报表、项目归属与员工修订流程；不等同于 GitHub Copilot |
| Google Workspace / Gemini | 有 Gemini 使用/行为日志；超级管理员的组织 Data Export 包含 Gemini 数据，需满足账号和组织条件 | 日志与内容导出不同；不能据此声称普通经理能实时读取所有聊天，或 Vault 覆盖所有 Gemini 会话 |
| GitHub Copilot Business / Enterprise 管理面 | 组织/企业用量报表包括聚合、用户、仓库维度；dashboard 不包括 CLI 用量 | 不是完整对话/工作成果账本，不能直接产生可信日报 |

核对的官方来源：

- [OpenAI Work 管理 FAQ](https://learn.chatgpt.com/docs/enterprise/work-admin-faq)、[合规接口边界](https://learn.chatgpt.com/docs/enterprise/compliance-api)、[成员生命周期与私人会话边界](https://learn.chatgpt.com/docs/enterprise/user-lifecycle)。
- [Claude 组织数据导出](https://support.claude.com/en/articles/13346720-export-your-organization-s-data)、[Claude Compliance API](https://support.claude.com/en/articles/13015708-access-the-compliance-api)。
- [Microsoft interaction export](https://learn.microsoft.com/en-us/graph/api/aiInteractionHistory-getAllEnterpriseInteractions)、[覆盖范围](https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/interaction-export/resources/aiinteractionhistory)。
- [Google Gemini 日志](https://knowledge.workspace.google.com/admin/reports/gemini-for-workspace-log-events)、[Google 组织导出](https://knowledge.workspace.google.com/admin/migrate/export-all-your-organizations-data)。
- [GitHub Copilot metrics 数据说明](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics)。

这些是当前文档覆盖的主要产品，不是对所有厂商所有套餐的保证。没有任何上述用量接口自动满足“跨两个客户端、过滤私人内容、员工可改、飞书日报周报及完整修订审计”这一整套需求。

## 结构：两个入口，一份工作账本

```text
Relay 现有 SecretaryProxy + 持久事件 ─┐
                                     ├─ 工作范围过滤 → 规范化事件/持久 outbox
OmO 扩展 hook → 独立 secretary agent ─┘                 ↓
                                      工作证据账本 + 报表调度服务
                                                   ↓
                                 飞书员工日报/周报 + 团队汇总 + 修订日志
```

Relay 的 `src/memory/SecretaryProxy.ts` 是确定性的记忆管理器，会观察事件、工具结果和决策，持久化 memory；它不是完整的 LLM 日报 agent。沿用它，增加工作事件适配与报表投影；不能把全部 memory 或原始 tool args 直接上传。

OmO 指本机先前对齐的 **omo-ai 5.1.38 / OmO Native**，不是最初链接的 oh-my-openagent OpenCode 插件。已检查本地参考包 `docs/extensions.md`、`examples/extensions/notify.ts` 和 `examples/extensions/subagent/index.ts`：有 session/tool/turn hook、appendEntry 持久自定义条目、可隔离上下文的子 agent 示例。`agent_end` 可能还会重试/续跑，不能直接认定整项工作完成；`agent_settled` 才适合作为稳定触发点之一。这证明存在扩展入口，尚不等于已在用户安装版本完成插件加载验证。

独立 secretary agent 使用自己的模型配置、预算、上下文和队列。扩展负责可靠采集，不让 PM 决定是否调用秘书；秘书只读允许的工作证据、输出结构化摘要，不获得任意 shell、仓库写入或全盘会话读取权限。飞书凭据只给确定性的发布服务。不能只靠“你是秘书”的 system prompt 或仅在退出 hook 上总结：强杀会漏记录，客户端退出后也无法按时发周报。

## 采集规则先于模型

1. 企业管理后台登记 `tenant + employee + project + canonical workspace root + policy version`；身份绑定飞书用户标识，不从 Windows 用户名推断员工。
2. 路径 realpath 归一化，处理符号链接、目录切换、嵌套非工作目录、外部编辑器临时文件和子 agent 工作目录。未登记工作区在读取内容、进入摘要模型和 outbox **之前**拒收。
3. 非工作内容不上传、不保存正文/标题/哈希；如需统计，仅保留不含内容的过滤计数。工作区中也提供“本次私人/排除记录”显式标识；不能声称 LLM 分类能绝对识别私人问题。
4. 只抽取任务目标版本、完成/失败、验证结果、交付物链接、提交/PR、阻塞及必要决策。凭据、完整文件内容、工具命令参数和原始聊天默认不入报表。
5. 被允许的工具输出仍是数据，不执行其中的指令；凭据/个人信息脱敏及企业共享策略由确定性规则执行。工作日报不替代正式 DLP、安全调查或完整考勤。
6. 员工可查看采集范围、暂停个人记录、纠正归属；企业工作区政策和可见性须明确告知。不能从“没有记录”推断员工没工作。

## 事件与恢复契约

共享事件字段：`schema_version, event_id, source_client, source_instance, source_session, source_seq, tenant_id, employee_id, project_id, work_item_id, goal_revision, occurred_at, evidence_refs, outcome, policy_version`。

本地写入与 outbox 入队同一持久事务；发布使用事件 ID 去重和持久消费游标；重启补读未消费工作事件；超期/被删除来源记录“证据缺口”，不编造补全。两端同时触达同一工作项时，以共享 work_item_id、提交 SHA 或交付物 ID 关联；不能只靠相似文字合并。客户端事件 ID 去重与跨客户端同工作归并是两层机制。

秘书只观察目标变更和取消，不能重新派发已经 superseded 的任务。摘要标明计划/进行中/已完成/已验证；Worker 的一句 done 不当作验收事实。报表包含证据来源区间、规则/模板版本、摘要模型、生成时间和内容摘要；不把 token 数折算为工作时长。

outbox 有重试上限、退避、隔离队列与费用预算；飞书故障不阻塞 PM。服务端调度负责用户当地工作日与周界线、迟到事件和补报；客户端不在线时，报表标记最后同步时间与数据未齐状态。

## 飞书文档与修订

采用企业自建应用、明确授权的工作文件夹/知识空间；员工只能访问本人草稿及获授权项目，leader 只看获授权员工/项目的工作报告。应用使用所需的最小权限，拒绝默认全租户读取。

- 自动生成员工日报/周报，员工在飞书云文档直接查看、补充和纠正。团队汇总基于有效的员工报告版本。
- 机器生成区和员工编辑区独立；每次发布记录上次读取的版本/内容摘要。发布前发现人工修改就合并或生成新修订，禁止整篇覆盖。
- 发布键为 `tenant + employee + period + report_kind`，本地/服务端 registry 维护文档 token 与版本。网络超时后的 create 结果未知时先对账再重试，不能盲目重复创建。
- 修订日志追加记录 actor、时间、base/report revision、修改理由（如填写）、前后内容摘要、证据集、生成规则版本和文档链接。正式版本做独立快照，修订 supersede 旧版本，不能改写过去记录。
- 飞书 UI 历史版本用于员工查看；不能假定其 API 暴露每次编辑的完整逐字 diff、所有编辑者或不可删除审计。具体事件/修订接口需在租户实测。若拿不到完整过程，明确显示“同步间隔内变化，作者/逐次操作未知”；若要求逐次精确审计，使用应用内修订入口或验证过的审计集成。
- 每日报告包括已完成、进行中、阻塞、下一步、验证/交付物证据；周报从证据与修订后的日报归并，不仅把原文拼接。

飞书官方有[创建、编辑与协作者权限的集成方案](https://open.feishu.cn/solutions/detail/docs?lang=zh-CN)、[创建 Docx](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)、[批量更新块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/batch_update)。应用审批、可见范围、修订冲突和上传幂等仍需我们实现/验证。

## 实施验收（完整链路一起验收）

| 情景 | 必须结果 |
| --- | --- |
| 工作/私人目录切换、软链接、外部编辑器、子任务 | 只有允许范围的工作事件进入秘书模型/报表出站队列 |
| 两端同任务、多员工同时写入 | 不重复计功，不串员工，不串项目 |
| PM 进行中、普通追问、变更/取消 | 不阻塞 PM；旧目标不复活；日报状态正确 |
| 采集/摘要/发布每一步强杀与重启 | 不丢已提交事件、不重复文档，结果未知可对账 |
| 模型编造完成、缺证据、费用耗尽 | 缺证据不标已验证，停止原因可见 |
| 员工编辑、发布竞争、撤回、周报补报 | 保留员工修改、前版本、修订关系与来源 |
| 飞书 401/403/429/5xx、租户/权限错误 | 有界重试、无跨租户泄漏、PM 不受影响 |
| 客户端离线、跨时区、删除/到期清理 | 明示同步时间和缺口，保留期按政策执行 |

首个可用版本应同时覆盖：工作范围过滤、两端适配、持久 outbox、员工日报、飞书查看/修改与修订、周报归并、强杀恢复。真实飞书联调需要指定企业应用与工作文件夹，目前没有这些配置，不宣称已上线。
