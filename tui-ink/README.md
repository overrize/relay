# Relay — 开发者文档

多 agent TUI 的实现包。项目介绍和快速上手见 [../README.md](../README.md)。

主交互与 OmO 对照见 [交互对照](docs/relay-interaction.md)。

合同价与历史价目表导入见 [价格导入说明](docs/price-import.md)。

---

## 常用命令

```bash
npm run dev              # 启动 TUI（live 模式）
npm run dev -- --demo   # 演示模式，不需要 API key
npm run typecheck        # tsc --noEmit
npm test                 # 全部单元/集成测试
npm run test:headless    # headless e2e 测试（store / 协议 / stage0）
npm run test:e2e         # 完整 e2e 测试（需要 API key）
```

---

## 架构

### Agent 层级

```
PM (depth=0, role=Leader)
└── Tech Lead (depth=1, role=Leader)   ← PM spawn 的
    └── Worker (depth=2, role=Worker)  ← TL spawn 的
```

- PM 不能直接 spawn Worker（`pm_cannot_spawn_worker` 错误）
- Worker 不能 spawn 任何人（`worker_cannot_spawn` 错误）
- 最大并发子节点 4（`/fanout N` 调整）

### 通信规则

| 发送方 | 接收方 | 合法性 |
|---|---|---|
| Worker | user | 非法，自动转发至 parent 并纠正 |
| Worker | Worker | 非法，拦截 |
| Leader | Leader | 合法（TL message→PM） |
| Leader | user | 合法，经 OutboundGateway 出口 |

### 消息流（飞书路径）

```
飞书 WS frame
  → protobuf 解析（websocket.ts）
  → inbound/feishu.ts 文本提取（text/post/at）
  → ConversationRuntime 状态机（base/fork 路由）
  → PM sendCommand
  → LLM 回复
  → OutboundGateway（抑制 → 格式 → 消毒）
  → ReplyAggregator（chunk 聚合）
  → 飞书 API 发送
```

---

## 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.tsx` | 入口，快捷键，`startLeaderAgent` / `startWorker`，agent 生命周期 |
| `src/store.ts` | Zustand store，`applyEvent`，UI 状态 |
| `src/protocol.ts` | 全部事件类型定义（`TuiEvent` / `AgentCommand`） |
| `src/adapters/httpAgent.ts` | LLM HTTP 流式对话，SSE 解析，history trimming，resume 加载 |
| `src/bus/Bus.ts` | SpawnBus：全局类型化 PubSub，agent 间事件路由中枢 |
| `src/inbound/feishu.ts` | 飞书消息解析：text / post 富文本 / at 等 → 纯文本 |
| `src/runtime/ConversationRuntime.ts` | 全双工会话状态机，base PM + fork PM 路由 |
| `src/runtime/TurnController.ts` | 单轮输入缓冲，并发保护 |
| `src/runtime/TaskScheduler.ts` | 异步任务队列，防止并发写入 |
| `src/runtime/FollowupRouter.ts` | 追问路由（PM fork 接力链） |
| `src/feishu/websocket.ts` | 飞书 WS 长连接客户端，protobuf 解析，自动重连 |
| `src/feishu/outbound/OutboundGateway.ts` | 所有出口消息的统一管道 |
| `src/feishu/replyAggregator.ts` | chunk → turn-end flush，防止碎片发送 |
| `src/memory/MemoryStore.ts` | `.spawn/memory/` 唯一 I/O 层，原子写，session 管理 |
| `src/memory/SecretaryProxy.ts` | 订阅 TuiEvent，自动维护 AgentMemory，btw 旁路，60s 快照 |
| `src/pm/ProcessManager.ts` | spawn 前置校验，60min 硬超时，软超时 nudge，告警 |
| `src/execution/WorkspaceBoundary.ts` | Worker 工作目录隔离 |
| `src/cache/CachePrefixManager.ts` | prompt cache 前缀复用（Fork 时共享） |
| `src/tools/registry.ts` | 工具注册表，`executeTool`，`toolNeedsApproval`，CRLF 归一化 |
| `src/protocol/normalizer.ts` | agent 输出协议解析，prose 容错（裸文本 fallback） |

---

## 内存 / 上下文系统

spawn 有**两种"上下文"**，互相独立：

### 1. LLM 对话历史（httpAgent 管）

每个 agent 在内存里维护一个 `messages[]`（`{role, content}[]`），这是实际发给 LLM API 的内容。

- **持久化**：`SecretaryProxy.observeMessage()` → `MemoryStore.appendMessage()` → `.spawn/memory/<id>.sessions.json`
- **Resume 时**：httpAgent 从 sessions.json 重建最后一个 session 的消息历史
- **截断规则**：总字符 > 60K 时从最旧 session 开始丢，始终保留最后 4 条消息

### 2. Working Set / Memory（SecretaryProxy 管）

结构化元数据，**不是** LLM 对话记录：

```
working_set.facts[]      — 从工具结果 / btw 消息自动提取的事实片段（Jaccard 去重）
working_set.decisions[]  — 从 assistant 回复里识别出的决策句
child_handles[]          — 子 agent 状态追踪
tombstone                — compact_summary / resume_hint / final_status
```

持久化到 `.spawn/memory/<id>.json`。SecretaryProxy 是**纯 TypeScript，不消耗 token**，只是一个事件监听器。

### 层级间的 memory 流动

```
Worker unit.handup → facts_to_promote → TL 的 SecretaryProxy
TL agent.done → ingestChildMemory() → PM 的 SecretaryProxy（最后 5 条 facts + 3 条 decisions）
```

### session 文件生命周期

- `<id>.json`：agent 运行时存在，`agent.done` 时删除
- `<id>.sessions.json`：永久保留（最多 5 个 session），供 `/resume` 使用

---

## 工具

Agent 可调用的工具（`src/tools/registry.ts`）：

| 工具 | 说明 | 需要审批 |
|---|---|---|
| `Read` | 读取文件（支持 offset/limit） | 否 |
| `Write` | 写入/创建文件 | 否 |
| `Edit` | 精确字符串替换，自动 CRLF 归一化（Windows 兼容） | 否 |
| `Bash` | Shell 命令，有 banned list（curl/wget/ssh 等） | 按命令判断 |
| `Grep` | 基于 ripgrep 的正则搜索 | 否 |
| `Glob` | 文件路径匹配 | 否 |
| `LS` | 目录列表 | 否 |
| `Think` | 内部推理记录，不输出给用户 | 否 |
| `WebFetch` | 获取 URL 纯文本，自动去 HTML | 否 |
| `WebSearch` | 互联网搜索（需 BRAVE_SEARCH_API_KEY 或 SERPER_API_KEY） | 否 |

破坏性 Bash（`rm` / `git commit` / `npm install` 等）→ 路由至父 Leader 审批，不直接问用户。

**Windows 注意**：Edit 工具自动检测 CRLF 文件，匹配时归一化到 LF，写回时还原 CRLF，worker 直接用 `\n` 写 old_string 即可。

---

## 飞书接入

### 配置

`.env` 中填入：

```
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

启动后自动连接飞书 WS 长连接（`startFeishuWebSocket`），日志写入 `feishu-debug.log`。

### 消息类型支持

| 类型 | 处理方式 |
|---|---|
| `text` | 直接提取 `content.text` |
| `post` | 提取 `zh_cn/en_us` 下的 title + text tag 拼接 |
| 其他 | 跳过，不加入 dedup 缓存（允许 Feishu 重试） |

### 出口管道（OutboundGateway）

所有发给用户的内容必须经过：

```
SuppressFilter   — 是否应该发送（过滤派活通知等内部消息）
FormatDecider    — 文本气泡 or 文档卡片
Sanitizer        — unescape / strip markdown
ReplyAggregator  — chunk 聚合，turn-end 一次性 flush
```

### 诊断日志

`feishu-debug.log` 的关键标志：

| 出现 | 说明 |
|---|---|
| `[FeishuWS] connected` | WS 连接成功 |
| `[FeishuWS] [recv] event_type=im.message.receive_v1` | 收到消息事件 |
| `[FeishuWS] [recv] text="..."` | 文本提取成功 |
| `[FeishuBridge] onMessage` | 进入 PM 前 |
| `[feishu-pm-inject] new session →` | 消息注入 PM |

---

## 可靠性机制

| 机制 | 实现位置 | 说明 |
|---|---|---|
| 工具结果路由 | `index.tsx` startWorker | 用 `user.message` 批量交付，不用 `tool.result`（防双前缀） |
| 连续失败熔断 | `index.tsx` startWorker | 5 次连续工具失败 → 强制 handup |
| 轮次上限 | `index.tsx` startWorker | MAX_WORKER_TURNS = 40，到限强制 handup |
| 飞书 at-least-once 去重 | `websocket.ts` | event_id 去重，dedup 在文本提取**之后**（防空文本污染缓存） |
| 消息空文本守卫 | `index.tsx` dispatchMessage | 空文本不进 PM，不创建 session |

---

## 测试

```
src/tests/
├── smoke.test.ts                    store applyEvent / scroll / approve 基础行为
├── integration.test.ts              SecretaryProxy / ProcessManager / HttpConvAgent / resume
├── pm-hierarchy.test.ts             PM 层级规则 / memory 持久化
├── registry.test.ts                 工具注册表 + Grep/Glob（需要 rg）
├── registry-enoent.test.ts          rgNotFoundResult 纯函数
├── coding-tools.test.ts             Edit CRLF 归一化（4 个用例）
├── cache-prefix.test.ts             CachePrefixManager
├── feishu-stream.test.ts            飞书流式响应
├── maxtokens-tiering.test.ts        max_tokens 分级
├── build-chat-path.test.ts          buildChatPath URL 构造
├── baseline/
│   └── full-duplex-golden.test.ts   全双工黄金路径回归
├── inbound/
│   └── feishu.test.ts               inbound/feishu.ts 文本提取（text/post/at/其他）
├── runtime/
│   ├── conversation-runtime.test.ts  ConversationRuntime 状态机
│   ├── followup-router.test.ts       FollowupRouter 追问路由
│   ├── turn-controller.test.ts       TurnController 并发保护
│   └── task-scheduler.test.ts        TaskScheduler 队列
├── execution/
│   └── workspace-boundary.test.ts    WorkspaceBoundary 隔离
└── feishu/
    ├── reply-aggregator.test.ts       ReplyAggregator chunk 聚合
    ├── input-window.test.ts           InputWindow 消息合并窗口
    ├── dedupe.test.ts                 飞书消息去重
    ├── concurrent-dispatch.test.ts    并发 dispatch
    ├── concurrent-scenarios.test.ts   并发场景
    └── outbound.test.ts               OutboundGateway 管道
```

Grep/Glob 测试用 `hasRg` 守卫：rg 不在 PATH 时自动 skip。

---

## 平台注意事项

- **Windows**：原子 rename 是 best-effort；EPERM（AV 扫描器持文件锁）已全部 try/catch
- **Windows**：`chcp 65001` 在启动时自动注入（GBK 编码修复）
- **Edit 工具**：自动检测并保留 CRLF，worker 用 `\n` 写 old_string 即可
- **ripgrep**：需手动安装，`scoop install ripgrep`（需在系统 PATH，不只是 PS PATH）
- **Linux/Mac**：rename 真正原子；rg 需要手动安装

---

## CI

`.github/workflows/ci.yml`：

- `ubuntu-latest`，Node 22
- 步骤：`apt install ripgrep` → `npm ci` → `typecheck` → `npm test`
- 触发：push / PR 到 main
