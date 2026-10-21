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
| Agent 列表 | Ctrl+G 或 `/agents`；`/chat` 返回会话；不占用 Shift+Tab |
| 计划与调试 | `/plan`、`/logs` |
| 分工策略 | `/strategy`；旧 `/effort` 保留兼容，但明确标注不是模型推理强度 |

模型 Enter 选择仅在当前进程覆盖用途和有效路由，Ctrl+S 才原子写入默认配置；其他高级 profile 保留。**当前角色的下一次请求和新启动的 Agent 使用新选择；进行中的请求保留原模型与费用快照。不会为了切模型终止 Worker。** 推理强度在相同接入的后续 HTTP 请求上更新，已发出的请求不改参数。CLI 订阅和没有能力元数据的供应商暂不猜测推理级别。

当前仍未完全等同于 OmO：全部快捷键自定义、外部编辑器、完整供应商目录和全部供应商推理能力尚待补齐。Relay 的用途 Tab 是保留多 Agent 设置的扩展。

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
