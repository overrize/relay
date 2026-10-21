# 第二阶段：共享 SessionController 与真实 Native TUI

2026-10-21，基于 `51fb67d`。正式入口继续默认使用旧 TUI；本阶段新增真实 Native 会话入口，不替换第三阶段尚未迁移的登录和配置工作流。

## 启动与操作

先正常退出当前工作区的旧 Relay。PowerShell：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File E:\spawn-work\open-relay.ps1 -Native
# 或在当前终端运行
& E:\spawn-work\relay.cmd --ui=native
```

每个工作区保持单一执行实例。`npm run ui:preview` 仍是上一阶段的纯交互验证，不调用真实模型；`npm run ui:native` 才是真实会话。

- 首条消息建立任务目标。之后 Enter 发送普通沟通：可在 Worker 工作期间追问，不改变目标版本，该请求不能发出工具或新派发。
- `/revise 新目标` 明确改变目标，先持久失效旧版本并取消旧请求/工具，待取消屏障后执行新目标；草稿与排队输入不混入旧版本。
- `/continue` 明确继续当前目标；`/resume` 在重启后恢复持久状态，先核对不确定副作用。已连接的执行不会因重复 `/resume` 被重建。
- Esc 或 `/interrupt` 停止当前执行，保留目标、TODO、决策及审计，阻止旧任务继续。恢复需明确操作。
- `/status`、`/tasks`、`/budget` 显示当前快照、任务停止原因和累计预算。
- `/exit` 或 Ctrl+C：停止当前进程的任务，等待清理和索引收尾，保留恢复记录。
- `/detach`：仅在本进程 HTTP 服务正常启动时可用。关闭界面但后台仍在**同一进程**运行；再按 Ctrl+C 可停止。尚未提供另一个终端附着该进程的 CLI，关闭承载终端也可能结束进程。它不是独立守护进程。

登录、模型选择/保存默认、跨会话历史搜索、外部编辑器、完整审批面板与布局迁移仍属第三阶段。使用旧界面配置模型，再启动 Native。未迁移命令明确报错并保留草稿。

## 边界

`SessionRuntime.ts` 持有既有运行时、prompt 构建、PM/Worker handlers 与清理；`SessionController.ts` 提供 `start/send/revise/continue/resume/interrupt/snapshot/subscribe/shutdown`，另有进程内 `detach`。

旧 TUI 的根 PM 输入/恢复/退出、HTTP 输入和新 TUI 经过同一控制器。原配置命令仍由旧 UI 适配层承担，但 command context 已移除 React ref；根会话操作通过回调进入控制器。飞书原有 handler 集成保留，没有在本阶段重写其消息合并和并发会话逻辑。

Store 不再导入 React；Ink hook 移至 `tui/useStore.ts`。Native 入口不加载 Ink、React 或旧 stdout/光标补丁。快照只暴露会话状态、模型名称、预算和事件，不传递 provider 配置或密钥；订阅可独立释放，视图异常不会打断执行循环。

界面区分模型响应、工具执行、排队与停止状态。Worker 等待 Bash 时即使模型状态 idle，任务仍显示工具执行中。处理中/排队输入文本、需求版本、任务原因来自统一快照。

## 验证

`session-controller-round23.test.ts` 通过新界面和真实执行 handlers，使用本地 HTTP 协议服务控制时间：执行中沟通、禁止查询偷偷派发、断开后重新挂载视图、修订失效旧 Worker、真实 Write 文件、新进程恢复和预算不清零。恢复进程用模块加载守卫禁止导入 React/Ink。

显式真实 API 验证：`npm run test:live:native`。它使用已配置 PM/Worker，在独立 `.test-tmp/native23-live-*` 目录运行受控角色提示词：Worker 执行可取消 Bash；PM 执行中回应；修订后生成新文件，旧文件不存在；强杀后恢复、Read 新文件并回复。凭据临时副本在驱动程序退出时删除，不输出密钥。保留无密钥的日志和 `verification.json` 供审计。此脚本消耗真实 API 请求，不放入 CI。

本轮真实 API 记录：`native23-live-E3Pk7A`，PM `kimi-k3`；执行中追问、旧任务取消、草稿保持、强杀恢复均通过；完成共 7 次累计请求。验证关闭自动补价，未定价消耗明确记为未知，不能将本地金额 0 理解为免费。

另在 Windows PTY 中使用默认产品提示词和真实 Kimi API，经 `--ui=native` 输入任务、实际 Write `native-smoke.txt`、收到 `NATIVE_TUI_OK`，后台刷新时中文/emoji 草稿保持。
