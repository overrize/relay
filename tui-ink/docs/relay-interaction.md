# Relay（接力）：OmO 交互对照

对照对象是本机 `omo 5.1.38 (engine: senpi 2026.10.19; scheme nodef)`，不是较早版本的 OpenCode 插件。已核对上游 `v5.1.38` 的依赖声明，以及公开发行包 `@code-yeongyu/senpi@2026.10.19` 的登录、模型选择、keybindings、footer、计价实现；没有复制上游实现代码。

## 主交互

| 操作 | Relay |
|---|---|
| 默认首页 | 会话输入；不用先穿过组织树 |
| `/login` | 订阅/API Key → 可搜索供应商 → 隐藏密钥输入 → 预置/账号模型 → 用途确认 |
| 模型选择 | `/model` 或 Ctrl+L；直接搜索名称/供应商，↑↓、Enter、Esc；Tab 切换 PM/Worker/Secretary 用途 |
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

模型选择保存相应默认用途（PM/实现 Worker/秘书）的路由，其他高级 profile 保留。**运行中任务保留原模型，选择的模型用于新启动/恢复；不会为了切模型强行终止 Worker。** 推理强度在相同接入的后续 HTTP 请求上更新，已发出的请求不改参数。CLI 订阅和没有能力元数据的供应商暂不猜测推理级别。

这轮对齐主操作，不声称已经与 OmO 的整个编辑器完全等价：完整多行编辑、跨会话 Ctrl+R 历史、所有快捷键自定义、模型选择的“仅本会话/存为默认”双模式以及全部供应商推理能力仍待补齐。Relay 的用途 Tab 是保留多 Agent 设置的扩展。

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

`npm run typecheck`、`npm test`、`npm run test:headless`、`npm run build`。新增实际渲染测试覆盖模型搜索、方向键、Enter/Esc、Ctrl+F，验证收藏不保存凭据，以及模型用途切换同步有效路由。独立 PTY 手工发送 Ctrl+L、Esc、q、Ctrl+C、Ctrl+D，核对界面和退出；运行在 E 盘隔离演示配置中，不改动用户凭据。
