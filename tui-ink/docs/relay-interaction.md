# Relay（接力）：OmO 交互对照

对照对象是本机 `omo 5.1.38 (engine: senpi 2026.10.19; scheme nodef)`，不是较早版本的 OpenCode 插件。已核对上游 `v5.1.38` 的依赖声明，以及公开发行包 `@code-yeongyu/senpi@2026.10.19` 的登录、模型选择、keybindings、footer、计价实现；没有复制上游实现代码。

## 主交互

| 操作 | Relay |
|---|---|
| 默认首页 | 会话输入；不用先穿过组织树 |
| `/login` | 订阅/API Key → 可搜索供应商 → 隐藏密钥输入 → 预置/账号模型 → 用途确认 |
| 模型选择 | `/model` 或 Ctrl+L；搜索名称/供应商，↑↓ 选择；Enter 仅本次使用，Ctrl+S 保存默认；Tab 切换 PM/Worker/Secretary 用途 |
| 收藏模型 | 模型选择器内 Ctrl+F；收藏独立保存到原配置目录的 relay-ui.json，不复制凭据 |
| 循环模型 | Ctrl+P 前进，Alt+P 后退；优先收藏，收藏为空时使用已接入模型 |
| 推理强度 | Shift+Tab；仅 HTTP OpenAI 兼容接口，通过精确模型的 `/models` 元数据读取 `effort.supported_levels` 后循环；未声明/查询失败时保持默认，不猜参数 |
| Ctrl+C | 对话中有输入时清空；空输入时沿用两次确认退出；选择器中取消 |
| Ctrl+D | 空输入时清理运行状态并退出 |
| Ctrl+O | 展开/收起工具结果 |
| Ctrl+T | 显示/隐藏当前思考步骤提示，不控制分工积极度 |
| Agent 列表 | Ctrl+B 或 `/agents`；`/chat` 返回会话；Ctrl+G 按 OmO 习惯用于外部编辑器 |
| 自定义快捷键 | `/keys` 查看有效绑定，`/keys edit` 编辑，`/keys reload` 校验并重载 |
| 外部编辑器 | Ctrl+G 或 `/edit`，使用 editor.json / VISUAL / EDITOR；后台 PM 和 Worker 继续 |
| 计划与调试 | `/plan`、`/logs` |
| 分工策略 | `/strategy`；旧 `/effort` 保留兼容，但明确标注不是模型推理强度 |

模型 Enter 选择仅在当前进程覆盖用途和有效路由，Ctrl+S 才原子写入默认配置；其他高级 profile 保留。**当前角色的下一次请求和新启动的 Agent 使用新选择；进行中的请求保留原模型与费用快照。不会为了切模型终止 Worker。** 推理强度在相同接入的后续 HTTP 请求上更新，已发出的请求不改参数。CLI 订阅和没有能力元数据的供应商暂不猜测推理级别。

当前仍未完全等同于 OmO：所有厂商的原生 OAuth、AWS/GCP 签名认证、专属协议功能与全部推理能力尚未实现。目录完整不等于这些认证和服务都已经实账验证。Relay 的用途 Tab 是保留多 Agent 设置的扩展。

## 快捷键配置

原配置目录下新增 `keybindings.json`，使用 OmO 风格的动作 ID，值为一个按键或数组，空数组取消绑定。首次启动读取；编辑后用 `/keys reload`，也可 `/keys edit` 直接调用外部编辑器。无效 JSON、未知动作和冲突不会覆盖当前有效映射，错误明确指出动作及场景；不会把被替换的旧 Ctrl 快捷键当成普通文字插入。

```json
{
  "app.model.select": ["f2", "alt+l"],
  "app.history.search": "alt+r",
  "app.editor.external": "ctrl+g",
  "app.model.save": "alt+s"
}
```

`/keys` 列出本版本所有可配置动作，包括发送/换行、光标/删除/撤销、菜单方向/确认/取消，以及模型保存/收藏/用途切换。对话、Agent 列表和各选择器按场景校验冲突；例如对话中的 Ctrl+P 循环模型，不阻止在选择器中把 Ctrl+P 配成上一项。Ctrl+I/M/H 与 Tab/Enter/Backspace 作为同一物理按键处理。支持 Ctrl+字母、Alt+字母或数字、F1..F12、方向/Home/End/删除键、Tab、Shift+Tab、Enter、Alt/Shift+Enter、Esc。传统终端不能区分的 Ctrl+Shift+字母不假装支持；工具审批的 y/n 和 Agent 列表旧字母命令仍保留固定行为。界面提示跟随当前有效绑定。

## 外部编辑器

配置目录的 `editor.json` 优先于 `VISUAL`，再优先于 `EDITOR`。未配置时给出设置说明，不擅自选择 GUI 编辑器。推荐独立参数数组，例如：

```json
{"command":["E:\\Apps\\VSCode\\Code.exe","--wait"]}
```

路径与参数不经过 shell 展开；Windows 使用 `.exe`，不要使用 `code.cmd` 包装器，GUI 编辑器必须选择能等待文件关闭的模式（例如 `--wait`）。环境变量的命令支持带引号的路径和参数。

Ctrl+G 编辑当前草稿，返回后仍需 Enter 才发送。父进程异步等待编辑器，释放控制台输入和鼠标/粘贴模式，暂停 TUI 对终端的绘制；后台任务、预算、日志与 PM 响应继续。编辑器退出后恢复原始输入模式、重绘界面和草稿。编辑器自己的 Ctrl+C 不会作为 Relay 的中断操作杀掉 PM。

临时草稿位于当前 E 盘项目的 `.spawn/editor-drafts/`；成功读取后移除本次临时文件，失败或非零退出时保留恢复路径和原草稿。修改快捷键时先验证新 JSON 和冲突，再原子保存；编辑器留下的 swap/backup 文件不会被递归删除。

## 完整供应商目录与能力边界

目录覆盖参考 OmO provider-map 中的 **49 个内置供应商**，从公开的 `@code-yeongyu/senpi-ai@2026.10.19` 提取 **1,936 个模型种子**，再保留原有兼容名称和自定义入口。仅导入名称、模型 ID、协议和端点，不把参考包的价格变成 Relay 的可信价格源或改写费用快照。账号模型接口仍优先，失败时明确退回未验证的预置列表。

OpenAI Chat Completions 和 Anthropic Messages 兼容服务可直接配置；补上 exactBaseUrl 以支持 `/v2`、`/v1beta/openai` 等前缀。Anthropic 兼容请求现在实际使用配置的主机、端口和路径。Google Gemini、Mistral、Ollama Cloud、xAI 使用官方 OpenAI 兼容面；需要账号/项目专用端点的项目会要求填写地址，预置地址缺失时不猜测。

对不接受 `stream_options` 的兼容接口可设置模型 `streamUsage:false`，Mistral 接入默认省略该可选字段。若厂商仅返回一部分 Token 用量，缺失的数字不补成零，保留完整预留并标记 uncertain，防止目录扩展导致费用漏记。

Codex、Claude、Copilot 继续使用原有官方 CLI/SDK 订阅接入。套餐密钥类供应商可用 HTTP 接入，并按 subscription 记录请求和 Token，不将 Token 费用当成套餐剩余。其他未实现的 OAuth/原生云协议会显示明确说明；若改用付费 API 或自备网关，需要在向导中明确选择，不能静默从订阅落到 API。Claude 403 未重新探测，Copilot 仍待真实登录验证。没有对应厂商账号的项目只完成协议和配置测试，不宣称已通过账号推理验证。

来源及更新方式见 [供应商目录来源](provider-catalog-sources.md)。

本轮 Windows PTY 实测：从配置读取 F2 打开模型、Alt+S 保存默认的映射；编辑器真实接管控制台后，服务端记录 `request.completed` 时 `editorStarted=true`、`editorFinished=false`，且 PM 日志已进入 idle。按键结束编辑器后界面恢复两行中文/emoji 草稿，无自动发送；缺失编辑器可执行文件时原草稿和恢复文件保留。供应商搜索可区分 Google Gemini 与标注“需要兼容网关”的 Vertex AI。HTTP 协议使用本地服务验证，未冒充没有账号的供应商实账验证。

## 多行编辑与历史搜索

Enter 发送；Alt+Enter / Ctrl+J 换行；终端支持时也接受 Shift+Enter（CSI-u 或 modifyOtherKeys）。方向键按可见行移动，左右键与删除保持 Unicode 字素完整；Home/End、Ctrl+A/E 行首尾，Ctrl+U/K 删除到行首尾，Ctrl+W 删除前一个词，Ctrl+Z/Y 撤销/重做。长输入按终端宽度换行，并滚动显示有限行数。括号粘贴保留空行和换行，整块插入草稿，不触发发送或 Ctrl 快捷键；输入中的 Tab 转为四个空格。

Ctrl+R 打开跨会话搜索，↑↓ 选择，Enter 恢复完整文本到编辑器，**不会自动发送**；Esc/Ctrl+C 返回并保留原草稿。记录按配置目录共享，包含时间、工作目录与会话标识；三字以上子串使用 SQLite trigram 索引，短词采用限制结果数的查询。搜索与保存失败会明确提示，不影响当前消息发送。记录位于配置目录中的 `prompt-history.sqlite`，从此版本开始记录本地 TUI 提交的输入；不会启动时扫描旧账本，旧对话仍可通过原有会话记忆和审计访问。认证命令、显式凭据赋值及明显令牌不写入搜索历史，原有账本不因搜索而修改。

Windows 新窗口启动使用 `pwsh -NoProfile -ExecutionPolicy Bypass -File E:\spawn-work\open-relay.ps1`。脚本通过 `-File` 启动交互终端，避免 `-Command` 的分号被 Windows Terminal 拆成新标签命令；新窗口默认使用动态 REST 端口，避免与已有窗口的 3001 端口冲突。

## 名称与兼容

产品名称为 Relay（接力），主启动入口 `E:\spawn-work\relay.cmd`。旧 spawn.cmd 转发新入口。保留原工作目录、`.spawn`、`SPAWN_*` 配置和协议中的 spawn 事件含义，避免已有密钥、会话、预算和恢复记录失效。内部模块和既有历史文件名不因品牌改名而重写。

## OmO 价格实现与 Relay 的区别

senpi 模型注册表装配模型目录及用户覆盖。`provider-composer.js` 将用户 `cost` 覆盖到模型；其注释明确手工成本覆盖优先于目录定时价卡。打包的 `calculateCost(model, usage, atMs)` 按生效价卡和输入量 tier 选择费率，计算 input/output/cacheRead/cacheWrite，结果存在 assistant message 的 `usage.cost`；footer 汇总 usage，并对订阅显示 `(sub)`。

这属于调用计价与显示，不等于厂商账单核验。在核对的模型、配置和费用显示实现中，没有据此确认存在与 Relay 等价的人工合同逐行撤销、原子跨端点迁移、修订原因及受保护账本工作流。Relay 保留这些已验证的能力，通过 `/prices`、`/audit` 提供高级入口。

参考：
- https://github.com/code-yeongyu/oh-my-openagent/blob/v5.1.38/packages/omo-native/package.json
- https://www.npmjs.com/package/@code-yeongyu/senpi/v/2026.10.19
- https://api-docs.deepseek.com/api/list-models/

## 本轮验证

斜杠菜单默认选中第一项，用明确的 `→` 指示选中行，避免无颜色终端无法辨认反色。↑↓ 循环选择，Enter 执行，Tab 补全；Esc 先关闭菜单并保留输入，不打断 PM。输入空格进入参数后收起菜单，继续编辑后可以重新打开匹配列表。

Windows PTY 实测从 `/` 用方向键进入 `/login`，选择 API Key、搜索 DeepSeek 并进入密钥输入后取消；用真实配置打开 Ctrl+L，确认 PM 当前为 kimi-k3，Tab 切换 Worker 后 current 标记为 deepseek-flash。未改写用户配置，也未重新进行订阅认证。

本轮独立 Windows PTY：Enter 临时选 model-b 后发起 HTTP，请求实际使用 model-b，磁盘默认仍是 model-a；重启显示 model-a，Ctrl+R 恢复上次多行输入且没有新增请求；粘贴三行中文/emoji 后发送，HTTP 接收到完整三行；Ctrl+S 保存 model-b 后磁盘默认同步更新。隔离配置在 `.test-tmp/relay18-live`，使用本地 HTTP 服务；真实用户配置未被测试改写。测试还验证请求中途改模型时，旧/新调用的保留单价分别结算，订阅账号没有重新认证。

`npm run typecheck`、`npm test`、`npm run test:headless`、`npm run build`。新增实际渲染测试覆盖模型搜索、方向键、Enter/Esc、Ctrl+F，验证收藏不保存凭据，以及模型用途切换同步有效路由。独立 PTY 手工发送 Ctrl+L、Esc、q、Ctrl+C、Ctrl+D，核对界面和退出；运行在 E 盘隔离演示配置中，不改动用户凭据。
