# Native TUI 工作流（第三阶段）

启动：`E:\spawn-work\relay.cmd --ui=native`，或 `open-relay.ps1 -Native`。目前仍显式启用，旧 UI 保留。

| 操作 | 行为 |
| --- | --- |
| `/login` | 方向键选择接入方式、可搜索供应商、认证、预置/账号模型、用途、确认保存。API Key 遮罩，不进入聊天和历史；Esc/Ctrl+C 仅取消该弹层及认证请求。 |
| `/model`、`/models`、Ctrl+L | 选择 PM/Worker、已配置模型，再明确选择“仅本次使用”或“保存默认”。进行中请求保持原模型，后续请求切换，底栏显示实际生效模型。Worker 选择影响后续新任务。 |
| `/history`、Ctrl+R | 搜索共享配置目录中的 SQLite 历史，可跨工作区和进程；Enter 只填回原始多行文本，不发送。Esc 保留原草稿和光标。 |
| `/editor`、Ctrl+G | 使用 `editor.json` 的 `command` 数组，或 VISUAL/EDITOR；GUI 请带 `--wait`。释放终端给编辑器，PM 继续；返回只更新草稿，失败保留原稿与恢复文件。 |

所有弹层使用同一个焦点所有者，退出回到原 Editor 实例，保留草稿、光标和撤销状态。已接收的用户输入才进入持久历史；认证命令和明显凭据不索引。模型列表接口失败仍显示预置模型，并说明未验证权限。

原生组件只适配现有 LoginFlow、认证、模型配置和历史服务。SessionController 提供不含密钥的模型目录及切换入口，继续使用真实 PM/Worker、统一预算、需求版本栅栏与恢复账本。普通追问保持沟通用途；`/revise 新目标` 明确取消旧任务，`/resume` 恢复持久目标。

## 验证记录

- 全量：891 项，884 通过、0 失败、7 个既有 TODO；82 项 headless 通过；typecheck/build 通过。
- `native-workflows-round24.test.ts`：原生方向键登录、密钥不回显、预置名称、明确确认保存、取消不保存、模型范围/角色、跨进程多行历史、长提示词尾部搜索、配置默认值与临时覆盖隔离、草稿光标保留。
- 扩充 `session-controller-round23.test.ts`：真实本地协议服务器 + PM/Worker 执行链，在登录弹层/外部编辑器中处理追问；编辑器失败恢复；继续验证旧任务取消、文件结果和新进程恢复。
- Windows 实际 PTY：走通 `/login` → API → DeepSeek → 遮罩输入 → 预置模型 → 取消，未保存测试凭据；方向键保存 Kimi 默认、仅本次切换 DeepSeek，底栏同步；Ctrl+G 运行真实子进程编辑器；重启 Ctrl+R 找到上次完整提示词并仅填回草稿。
- Windows 实际 PM：现有 Kimi API、正式角色提示词，实际 Write 创建 `native24.txt` = `NATIVE24_OK`；模型弹层打开时继续完成工具与回复。隔离目录 `.test-tmp/native24-terminal-a8702f5e99be4fd587a3d58b0f90fe62`。
- `npm run test:live:native`：真实 Kimi PM + DeepSeek Worker，在 Worker Bash 执行时打开/取消登录、模型、历史并运行外部编辑器、追问；`/revise` 取消旧任务，新文件有效、旧文件不存在；强杀测试进程后新进程恢复并保留预算。结果 `.test-tmp/native23-live-Y2uk6s/verification.json`，7 次真实请求。测试关闭自动补价，未定价金额仍为未知，不能理解为免费。

## 尚未完成的对齐

- 原生快捷键尚未接入旧 UI 的自定义键位文件；任务/审计/预算目前仍为文字视图，完整固定 dock/可滚动 transcript 布局留后续迁移。此次没有切换默认入口。
- Claude 按要求未改；Copilot 无账号，仍待实际登录验证。其余 OAuth/云身份复用现有实现，本轮没有为每家厂商重新做真实授权。
- 外部编辑器占用终端期间，PM 可通过原有 HTTP/飞书入口收消息，TUI 输入在编辑器退出后恢复；它不是编辑器和聊天同时占用 stdin。
- 本轮实际终端操作为 Windows PTY；Linux 由 CI 运行原生组件与真实执行链的本地协议端到端回归，不等同于在 Linux 桌面上逐供应商人工登录。
