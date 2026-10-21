# Relay 按 OmO Native 对齐的改造计划

日期：2026-10-21。基线：Relay `aeffe83`。本轮交付是结构调查、路线和独立交互验证入口，不表示完整 UI 迁移已完成。

## 决策

采用 OmO Native 的终端组件与界面/会话分层思路。直接固定依赖其使用的 `@code-yeongyu/senpi-tui@2026.10.19`，不再自行复刻编辑器和菜单的键盘解析。现有持久事件、需求版本、预算、执行隔离、恢复和验收机制继续作为后端约束。

目标调用链：`Terminal / Native UI → SessionController → SessionRuntime → Agent / Task / Tool`，反向通过快照和事件更新 UI。UI 不启动模型循环、不判定任务完成、不持有真实凭据，也不直接管理工具进程。

默认是用户持续与 PM 沟通、PM 直接派 Worker；额外管理层是任务需要时的策略。输入分为普通沟通、明确变更目标、取消执行，不将普通追问自动提升为目标变更。

## 调查边界与证据

调查的是用户截图中 `omo-ai 5.1.38` 的 **OmO Native**，而不是名字相近的 OpenCode 插件界面。

- 已运行的目标：`E:\Apps\OmO\bin\omo.exe`；SHA256 `7a9a08ff943749336ce2a8f72a41f83e7e65c22de13cfd108d7026b3ee61e787`。
- 发布声明：该版本使用 `@code-yeongyu/senpi@2026.10.19`；已取得可读发布源码，位于 `.test-tmp/omo-reference/package`。源码揭示依赖关系，并非对完整原生二进制的逐函数反编译，也不证明每段源码与编译结果逐字节等价。
- `dist/modes/interactive/tui-renderer.js`：`ProcessTerminal` 统一处理终端，构造 `TuiMainScreen` 或 `TuiAltScreen`；外部输出有专门的收口。
- `dist/modes/interactive/components/custom-editor.js`：继承成熟的 `Editor`，在其上加应用快捷键、提示和状态，编辑算法并非业务层重写。
- `dist/modes/interactive/chat-viewport.js`：可滚动 transcript 与固定 dock 分离，dock 内排列 pending/status/editor/footer。
- `dist/modes/interactive/components/login-dialog.js`：登录替换 editor 区；焦点传给唯一输入组件；取消由局部 AbortController 管理。
- `dist/core/agent-session.js`：`prompt()` 和订阅承载会话行为，处理 streaming 中的 steer/followUp，而非让界面组件承担执行循环。
- 运行观察：以 `--no-session --no-extensions --tui-mode regular` 打开本机程序，实际操作 `/login`、方向键选择 API Key、供应商列表、Esc 逐级返回及 `/exit`；未输入密钥、未登录账号、未发起推理。

以上是源码和普通终端观察证据，不冒充 REA Evidence。可读源码足以支持本轮结论，无需为分析安装反编译引擎或更改 MCP 配置。依赖使用 MIT 许可，作为正式依赖固定版本；没有整包复制 OmO 的业务实现或品牌资源。

## 主要差距

| 范围 | Relay 现状 | 目标与验证方式 |
| --- | --- | --- |
| 终端控制 | Ink + ShortcutInput + CursorAnchor + stdout shim 共同参与 | 唯一 terminal owner；编辑器、光标、输入协议和绘制使用同一组件体系 |
| 输入和弹层 | App hooks 协调多个选择态与 raw 控制键 | 单一 focus/composer surface，打开/取消保留同一个 editor 实例、光标和 undo/paste 状态 |
| 业务边界 | AgentRuntime 组合启动、HTTP、React、退出和终端补丁；commands context 含 React refs | 无 React 依赖的 SessionController；UI、HTTP、飞书走相同操作入口 |
| 消息与任务 | 已有持久恢复和停止原因，但 UI 需跨多个状态拼装 | 一份会话快照，显式 active/queued/paused/stopped/accepted；待发消息与执行中消息分开 |
| 测试 | 大量业务回归、部分 UI 组件测试 | 加真实组件焦点/光标/菜单/resize/后台更新组合测试，再测实际终端与真实后端 |

不以文件大小推断架构优劣：OmO 的 interactive 层也很大。关键是状态所有权、事件入口和终端生命周期的边界。

## 阶段与完成门槛

### 1. 同引擎交互验证（本轮）

- [x] 打开当前正式 Relay，供用户继续体验。
- [x] 固定 OmO 使用版本的终端库，建立独立 `ui:preview` 入口，不导入 Ink runtime、不调用 provider/tool、不写模型配置。
- [x] 实现成熟 Editor、可用方向键的斜杠补全、模型列表及单一焦点切换。
- [x] 验证中英文/emoji、多行、粘贴、草稿及光标保留、resize、模拟后台更新、退出释放终端。
- [ ] 用户对比体验反馈纳入阶段 2；阶段 1 不是可用于开发任务的替代客户端。

运行：在 `tui-ink` 下 `npm run build`，再 `npm run ui:preview`。正式入口仍是根目录 `relay.cmd`。

### 2. 先抽会话控制器，再接真实 PM（已完成核心接入）

- 抽离初始化/关闭生命周期、规范化操作和事件订阅，保持正式旧 UI 调用同一控制器，避免另建一套执行后端。
- 把 React ref 从 command context 移出；命令返回结构化结果或 UI 意图。建立 `send / revise / interrupt / snapshot / subscribe / shutdown` 边界。
- 新 UI 订阅真实状态，显示 pending/active 文本及任务停止原因；不中断 PM 时可以输入和发送追问。
- 普通提问、目标变更、恢复分别验证。目标修订后旧请求与旧工具必须被阻断；退出 UI 的行为必须显式区分“断开界面”和“停止任务”。
- 门槛：同一个真实 PM 在执行中响应追问；连续多次变更不漏取消；后台事件与弹层不吞字；不绕过预算/日志/隔离/验收。

本阶段实施与验证见 [共享 SessionController](native-session-controller.md)。Native 通过 `--ui=native` 启用；默认界面、完整配置和独立进程附着尚未切换。

### 3. 完整迁移交互工作流

登录、模型范围/默认值、跨会话历史和外部编辑器现已接入真实 Native TUI，操作与验证见 [第三阶段工作流](native-workflows.md)。自定义键位、任务/审计/预算面板及固定输入/滚动历史已继续迁移，见 [原生布局与面板](native-panels.md)。切默认、移除旧路径与更大历史虚拟化仍待后续门槛完成。

- 登录：复用现有认证服务与 LoginFlow，原生 selector/input 替换 JSX；密钥输入不回显、不进入历史，取消清理认证任务。
- 模型：账号/预置目录、当前实际模型、仅本次/保存默认、角色分配使用统一界面状态，保留计费类型提示。
- 跨会话历史、外部编辑器、键位配置、任务/审计/预算面板迁移到统一 command controller。
- 布局采用 transcript + 固定输入 dock；任务与组织视图按需打开，状态和编辑区互不覆盖；长历史先绘制尾部，历史按需加载。
- 门槛：Windows Terminal 与 Linux PTY 同一套完整流程；登录取消、键位重映射、编辑器失败返回、窗口缩放均保持草稿和焦点。

### 4. 切默认与移除旧控制路径

大归档分页索引及长历史虚拟窗口已先行完成，见 [分页索引与验证](transcript-index.md)。它们不表示切默认或删除旧 UI 已完成。

- 新 UI 覆盖上述流程并通过真实端到端用例后，才切为正式默认；迁移期间保留明确的旧 UI 回退入口。
- 删除旧 ShortcutInput/CursorAnchor/stdout shim 等重复的生产控制路径，避免同时运行两个输入系统。
- 后端调度默认直接分工；仅有依赖/规模证据的任务采用层级。秘书对应持续维护的事件/状态/上下文能力，不要求每条消息都通过额外模型角色。
- 门槛：真实开发任务达到文件改动、测试、验收闭环；Worker 异常退出可追溯并受预算控制续派；强杀重启不丢目标和停止原因；Linux/Windows CI 全通过。

## 验证与回退约束

每阶段都必须给出“用户操作 → 界面状态 → 后端事件 → 文件/测试结果”的证据。模拟后台事件只证明渲染并发，不能替代真实 PM/Worker 端到端验证。供应商无账号时明确保留待验证，Claude 暂不动、Copilot 待登录。

旧 UI 生产代码本轮未替换；预览配置只读、无真实执行，因此无需迁移会话数据。后续切换保持旧账本格式、模型默认、预算和历史费用快照不变。异常时回到旧 UI 仍能读取同一会话。

首次索引重建、分段元数据与线程复用已优化，见 [性能与验证](transcript-rebuild-performance.md)。

分段元数据缓存、大归档流式校验与重建进度见 [实现与验证](history-streaming-metadata.md)。
