# Relay · 接力

启动：`E:\spawn-work\relay.cmd`。旧 `spawn.cmd` 继续兼容；会话与配置仍沿用 `.spawn`，无需迁移密钥和账本。

打开独立 Windows Terminal：`pwsh -NoProfile -ExecutionPolicy Bypass -File E:\spawn-work\open-relay.ps1`。Alt+Enter / Ctrl+J 换行，Enter 发送；Ctrl+R 跨会话搜索输入历史；Ctrl+L 模型列表中 Enter 仅本次使用，Ctrl+S 保存默认。详见 [TUI 交互说明](tui-ink/docs/relay-interaction.md)。

## 运行模式与第一轮可靠性修复

默认 `adaptive`：PM 可以直接完成简单工作，或直接派发 Worker；只有需要协调时才增加 Leader。
原有组织层级仍可选择。PowerShell 示例：

```powershell
cd E:\spawn-work\tui-ink
npm run dev                              # 默认 adaptive
npm run dev -- --mode=hierarchical        # PM → Leader → Worker
npm run dev -- --mode=single              # 一个 PM 使用工具，不派生 agent
```

也可设置 `SPAWN_ORCHESTRATION=adaptive|hierarchical|single`，命令行优先。
`SPAWN_CONFIG_DIR` 可指定配置目录，默认沿用原有用户配置。

本轮改动：所有运行时接受的工具结果统一交给秘书；并发 PM 分身和合并对话持久化；
完成的任务保留恢复快照；工具调用状态及时落盘；事实只合并完全相同的文本，避免把否定或条件变更吞掉。
历史和恢复注入使用整体预算，超大消息会截断；原始完整消息仍保存在会话文件中。
长命令异步执行，可取消进程树。PM 回复后释放飞书会话锁，后台任务不阻止后续沟通。
取消不回滚已发生的修改；恢复时应先核对未完成操作的实际副作用。

验证命令：`npm run typecheck`、`npm test`、`npm run test:headless`、`npm run build`。
`src/tests/reliability-round1.test.ts` 使用真实处理器、局部模拟模型服务和真实子进程，
验证后台 Worker 执行时 PM 仍可回复、秘书接收结果、分身恢复、预算和取消。
飞书真实账号收发及需求版本化、语义记忆整理属于后续验证和改造范围。

多 agent 对话系统。用户通过飞书或终端 TUI 发送任务，系统自动拆分并并行调度多个 LLM agent 完成，结果汇总回用户。

**开发者文档（架构、内存系统、Feishu 接入、测试）→ [tui-ink/README.md](tui-ink/README.md)**

## 快速上手

```bash
cd tui-ink
npm install
cp .env.example .env      # 填入 API key
npm run dev               # 启动 TUI
npm run dev -- --demo     # 无 API key 演示模式
```

`.env` 必填项：

```
OPENAI_API_KEY=...        # 或其他兼容 OpenAI 格式的 provider
OPENAI_BASE_URL=...       # 例如 https://api.deepseek.com
```

飞书接入（可选）：

```
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
```

### 系统依赖

需要安装 **ripgrep**（Grep / Glob 工具依赖）：

```bash
apt install ripgrep        # Linux
brew install ripgrep       # macOS
scoop install ripgrep      # Windows（需在系统 PATH）
```

**也可以在 TUI 内用命令配置 provider**：

```
/connect leader deepseek deepseek-chat sk-YOUR_KEY
/connect worker deepseek deepseek-chat sk-YOUR_KEY
```

支持的 provider：

| preset | 说明 |
|---|---|
| `anthropic` | https://api.anthropic.com（原生格式） |
| `deepseek` | https://api.deepseek.com |
| `openai` | https://api.openai.com |
| `ollama` | http://localhost:11434（本地，apiKey 填任意值） |

---

## 架构

```
PM (depth=0, role=Leader)
└── Tech Lead (depth=1, role=Leader)   ← PM spawn 的
    └── Worker (depth=2, role=Worker)  ← TL spawn 的
```

- PM 不能直接 spawn Worker（`pm_cannot_spawn_worker` 错误）
- Worker 不能 spawn 任何人（`worker_cannot_spawn` 错误）
- 最大并发子节点 4（`/fanout N` 调整）
- Worker → user 消息非法，自动转发至 parent 并纠正

每个 Agent 是一次 HTTP 流式 LLM 对话，由 SecretaryProxy 负责记录 memory，ProcessManager 负责生命周期监控。

---

## 布局

```
┌────────────────────────────────────────────┐
│ ● ● ● multi-agent · inbox          [q]uit │  ← TitleBar
├──────────┬─────────────────────┬──────────┤
│ AGENTS   │ ◆ pm                │ TODO     │
│  ◐ pm    │   消息内容…         │ ◯ 分析   │
│  · tl-01 │                     │ ◐ 执行   │
│  ✓ w-01  │                     │ ✓ 汇总   │
├──────────┴─────────────────────┴──────────┤
│ > 输入框                                   │  ← InputBar
│ log:info  [ up ] dn  y/n approve  q quit  │  ← StatusBar
└────────────────────────────────────────────┘
```

---

## 可用工具

Agent 可调用的工具（共 8 个）：

| 工具 | 说明 | 需要审批 |
|---|---|---|
| `Read` | 读取文件内容（支持 offset/limit） | 否 |
| `Write` | 写入文件（创建或覆盖） | 否 |
| `Edit` | 精确字符串替换（old→new） | 否 |
| `Bash` | 执行 shell 命令 | 按命令判断 |
| `Grep` | 基于 ripgrep 的正则搜索 | 否 |
| `Glob` | 文件路径匹配 | 否 |
| `LS` | 目录列表 | 否 |
| `Think` | 内部推理记录（不输出给用户） | 否 |

破坏性 Bash（`rm` / `git commit` / `npm install` 等）路由至父 Leader 审批，不直接问用户。  
网络类命令（`curl` / `wget` / `ssh` 等）被 banned list 拦截。

---

## 快捷键

| 键 | 功能 |
|---|---|
| `Tab` | 切换选中 agent |
| `[` / `]` | 向上 / 向下滚动对话 |
| 鼠标滚轮 | 滚动对话内容 |
| `P` | 暂停当前 agent |
| `F` | Fork 当前 agent（新 Leader/Worker） |
| `C` | 查看当前 agent 详情 |
| `y` / `n` | 批准 / 拒绝待审批工具调用 |
| `q` / Ctrl+C | 退出 |

---

## 斜杠命令

| 命令 | 说明 |
|---|---|
| `/sessions` | 列出所有历史会话 |
| `/resume [agentId\|hash]` | 从 memory snapshot 恢复会话 |
| `/rate good\|bad [说明]` | 对刚完成的会话评分（记入 debug.log） |
| `/fanout <N>` | 设置最大并发子节点数（默认 4） |
| `/connect <role> <preset> <model> <key>` | 配置 LLM provider |
| `/palette paper\|green\|amber` | 切换配色方案 |
| `/layout` | 切换布局模式 |
| `/log` | 查看系统日志 |
| `/alerts` | 查看 PM 告警 |
| `/quit` | 退出 |

---

## Agent 协议（摘要）

```jsonc
// Leader spawn Worker（必须包含 dispatch 字段）
{"v":1,"type":"spawn","parent":"pm","child":"tl-01","role":"Leader",
 "goal":"一句话任务","dispatch":{"background":"...","constraints":[],
 "acceptance_criteria":["验收标准"],"stop_conditions":["agent.done"],"timeout_ms":600000}}

// Worker 完成
{"v":1,"type":"agent.done","agent":"worker-01","success":true,
 "reason":"完成描述","evidence":["src/foo.ts:42 改动说明"]}

// Worker 超出边界（handup）
{"v":1,"type":"unit.handup","agent":"worker-01","parent":"tl-01",
 "summary":"已完成 X，无法继续因为 Y",
 "findings":[{"level":"CRITICAL","text":"发现问题"}]}
```

完整协议见 `tui-ink/src/protocol.ts`，角色约束见 `prompts/`。

---

## 测试

```bash
cd tui-ink
npm test           # 全部测试（含 headless store / 协议解析 / 集成测试）
npm run typecheck  # TypeScript 类型检查
```

测试目录：

```
src/tests/
├── e2e/headless/
│   ├── store-events.test.ts      store applyEvent / pendingInputAgents / token supervision
│   └── protocol-parsing.test.ts  parseAgentOutput（infinite-loop / raw-JSON-leak 回归）
├── smoke.test.ts                 store 基础行为
├── integration.test.ts           SecretaryProxy / ProcessManager / HttpConvAgent / resume
├── pm-hierarchy.test.ts          PM 层级规则 / memory 持久化
└── registry.test.ts              工具注册表 + Grep/Glob
```

---

## 调试

所有日志写到 stderr，启动时重定向：

```bash
# Linux / macOS
npm start 2>debug.log
tail -f debug.log

# Windows PowerShell
npm start 2>debug.log
Get-Content debug.log -Wait -Tail 50
```

开启完整 LLM 原始响应日志（每轮 raw 输出）：

```bash
LOG_EVENTS=1 npm start 2>debug.log
```

不设置时只输出关键节点：resume 加载、网络重试、历史截断、质量评分等。

---

## 质量评分体系

每次 PM 任务完成后，系统自动在 debug.log 里写入一行结构化评分，同时在状态栏提示用户评分。

### 自动评分（客观信号）

任务结束时自动计算并写入 stderr：

```
[quality] pm session=abc1234 score=82 success=true turns=4 nudges=1 handup=false gaveUp=false rejects=0 tokens_in=4200 tokens_out=890 evidence=2
```

| 字段 | 说明 |
|---|---|
| `score` | 0–100，综合自动评分 |
| `success` | agent.done 是否成功 |
| `turns` | LLM 轮次数 |
| `nudges` | 系统催促次数（越多说明 agent 越被动） |
| `handup` | 是否触发了 unit.handup |
| `gaveUp` | 是否 3 次 nudge 全部失效 |
| `rejects` | 用户拒绝工具调用次数 |
| `tokens_in/out` | 本次会话 token 消耗 |
| `evidence` | agent.done 携带的证据条数 |

评分规则：基础 100 分，每次 nudge -8，gaveUp -25，handup -15，失败 -20，用户拒绝工具 -10；有 evidence +10，零 nudge +10。

### 人工评分（主观反馈）

任务完成后状态栏出现提示：

```
Session done — /rate good [comment] or /rate bad [comment] to rate
```

输入评分命令（comment 为可选文字说明）：

```
/rate good 这次 worker 很流畅，没有卡顿
/rate bad PM 问了三次才开始做事，handup 太频繁
```

写入 debug.log：

```
[rating] pm session=abc1234 human=1 comment="这次 worker 很流畅，没有卡顿"
[rating] pm session=abc1234 human=-1 comment="PM 问了三次才开始做事"
```

`human=1` 为好评，`human=-1` 为差评。发送下一条消息时提示自动消失。

### 如何分析数据

```bash
# 提取全部评分行
grep '\[quality\]\|\[rating\]' debug.log

# 只看差评会话
grep 'human=-1' debug.log

# 查看低分会话（score < 60）
grep '\[quality\]' debug.log | awk -F'score=' '{print $2}' | awk '$1+0 < 60'
```

**反馈数据上传**：把 `debug.log` 上传到 GitHub issue 或直接发给开发者，`[quality]` 和 `[rating]` 行不包含任务内容，只有数字和你填写的 comment，隐私安全。

---

## 目录结构

```
spawn-work/
├── README.md                   本文件
├── tui-ink/                    主程序（Ink / React + TypeScript）
│   ├── README.md               开发者文档 ← 看这里
│   ├── .env.example            环境变量模板
│   ├── prompts/                角色 prompt
│   │   ├── _base.md            公共前导：协议格式 + 行动偏见铁律
│   │   ├── pm.md               PM：Stage 0 并发感知 + 三阶段决策
│   │   ├── leader.md           Tech Lead：spawn 路由 + handup 处理
│   │   ├── worker.md           Worker：goal 边界 + agent.done 格式
│   │   └── worker-coding.md    Worker 编码专用 prompt（工具优先级 + CRLF）
│   └── src/
│       ├── protocol.ts         事件协议类型（TuiEvent / AgentCommand）
│       ├── store.ts            Zustand 全局状态 + applyEvent
│       ├── index.tsx           入口：快捷键 / 路由 / agent 生命周期
│       ├── adapters/
│       │   └── httpAgent.ts    HTTP 流式 LLM adapter
│       ├── bus/
│       │   └── Bus.ts          SpawnBus：全局 PubSub 事件总线
│       ├── inbound/
│       │   └── feishu.ts       飞书消息解析（text/post/at）→ InboundMessage
│       ├── runtime/
│       │   ├── ConversationRuntime.ts  全双工会话状态机（base/fork）
│       │   ├── TurnController.ts       单轮输入缓冲 + 并发保护
│       │   ├── TaskScheduler.ts        异步任务队列调度
│       │   └── FollowupRouter.ts       追问路由（PM fork 接力）
│       ├── feishu/
│       │   ├── websocket.ts    飞书 WS 长连接（protobuf 解析 + 重连）
│       │   ├── outbound/
│       │   │   └── OutboundGateway.ts  统一出口：抑制 → 格式 → 消毒 → 发送
│       │   └── replyAggregator.ts      chunk 聚合 + turn-end flush
│       ├── memory/
│       │   ├── MemoryStore.ts  .spawn/memory/ 原子 I/O
│       │   └── SecretaryProxy.ts  自动维护 AgentMemory + btw 旁路
│       ├── pm/
│       │   └── ProcessManager.ts  spawn 校验 / 超时 / 告警
│       ├── execution/
│       │   └── WorkspaceBoundary.ts  worker 工作目录隔离
│       ├── cache/
│       │   └── CachePrefixManager.ts  prompt cache 前缀复用
│       └── tools/
│           └── registry.ts    工具白名单 + executeTool + 审批判断
```

---

## CI

GitHub Actions（`.github/workflows/ci.yml`）：
- `ubuntu-latest`，Node 22
- 步骤：`apt install ripgrep` → `npm ci` → `typecheck` → `npm test`
- 触发：push / PR 到 main

## 第二轮：长会话、目标变更与恢复

继续使用 spawn 自身的运行时；组织层级仍由第一轮的 adaptive / hierarchical / single 模式选择。PM 在 Worker 执行命令时仍可以接收用户追问。

- `.spawn/events/journal.jsonl` 是追加写入并 fsync 的事件记录，带序号和哈希链；`current.json` 是可重建的派生快照。未写完整的末尾记录会单独保存，已提交记录损坏则停止执行，避免用错误状态继续工作。
- 用户输入、当前目标、约束、决策、TODO、任务状态、工具结果都进入同一事件来源。上下文编译器统一用于正常请求、分支和重启；旧目标不会作为当前指令注入。近期历史和兼容快照有界，完整历史可通过 `SessionRecall` 按关键词检索，并返回事件序号及目标版本。
- `/revise 新目标` 明确切换目标；`/constraint 新约束` 增加持久约束并使旧执行失效。进度问题保留当前目标。普通输入使用保守的规则分类；含糊的指令建议显式使用 `/revise`，分类目前不是语义理解器。
- 目标版本先持久化，再取消旧模型请求和工具进程树。新工具执行等待取消完成；迟到回复、审批、工具结果和前台转后台回调均检查版本，不能推进旧任务。
- 在相同工作目录运行 `npm --prefix tui-ink start -- --resume` 恢复 PM；`--resume=<根会话ID>` 可指定其他根会话。恢复时从事件记录重建状态，重发尚未处理的最新输入；旧 Worker 不会自动恢复执行。单个任务使用交互命令 `/resume`，过期任务会被拒绝。
- 中断时尚未确认的工具标记为 `uncertain`，相同调用 ID 的直接重放会被阻止；已完成 ID 返回缓存结果摘要。必须先检查文件或外部状态，再决定是否发起新操作。

验证：`npm --prefix tui-ink test` 包含 `session-round2.test.ts`；覆盖 180 轮历史、损坏/半写日志、真实子进程取消、迟到回复、异常退出跨进程恢复、持久收件箱和工具重放保护。另运行 `npm --prefix tui-ink run test:headless` 与 `npm --prefix tui-ink run build`。

第二轮的孤儿进程和恢复性能边界已在下面第三轮继续处理。事件持久化仍不等于模型每轮都会自动想起全部历史，旧细节需要检索；任意外部操作的恰好一次执行和副作用回滚也不由事件记录保证。飞书消息聚合窗口及实际网络投递仍需要单独联调。

## 第三轮：强杀后的进程清理与分段恢复

每个 shell 命令由独立 Node 监督进程持有进程树。启动前先持久化随机令牌、所属应用 PID 和存活租约到 `.spawn/processes/<令牌>/`；监督进程在启动命令前写入自身状态并检查取消请求。主程序丢失后，监督进程自动停止旧进程树；重启也会检查未完成记录，并通过令牌目录请求清理。恢复不把历史 PID 当作直接查杀目标。正常结束的记录移入 `completed/`，后续启动不必读取每一条已完成记录。

PM 对话与清理异步进行；新工具执行等待清理完成。取消进程树失败、监督进程非正常消失或清理超时，会保留明确的阻塞记录并拒绝新工具调用，PM 仍能回答进度问题。存活检测每 200 ms 检查一次，应用存活但租约超过 15 秒不更新时也会停止命令；长时间挂起或阻塞主程序可能因此中断任务。

事件日志默认在活动文件达到 4 MiB 后封存到 `events/segments/`。分段通过连续序号与哈希链关联，检查点用校验和、分段元数据和末尾事件锚点验证后使用；正常恢复仅处理检查点后的活动尾部。检查点缺失或损坏时退回全量校验重放，封存段缺失或内容校验失败则停止执行。轮转过程中被强杀、活动文件末尾半写和第二轮遗留的单文件日志均可恢复；旧单文件首次升级仍需完整读取一次。

`SessionRecall` 可跨所有分段检索，轮转不会漏掉原活动文件。受管理会话默认不再重复重写旧的整份 AgentOS JSON 诊断日志；如需该诊断通道可设置 `SPAWN_AGENT_OS_JOURNAL=1`。设置 `SPAWN_VERIFY_JOURNAL=1` 可跳过普通快速检查点，从恢复基线开始校验保留的原始日志；第四轮清理后的长期记忆在读取归档时另行校验。该模式用于排查，不用于性能测量。检查点是本地恢复优化，不是抵抗恶意修改的安全边界。

验证包含 `session-round3.test.ts`：真实强杀应用、无需重启的自动清理、监督进程也被杀时的阻断、历史 PID 复用防误杀、清理失败时 PM 持续对话、分段检索、多读取者轮转、检查点损坏回退及缺失分段。另使用构建后的程序和已配置的真实模型做强杀→重启验证，确认旧进程停止后才写入新目标文件，并恢复新目标、E 盘约束和早期记忆。

仍有边界：监督进程也被强杀、权限不足或程序主动脱离原进程树时，无法保证自动清理；不确定时保留阻塞记录，需要人工检查。已经发生的文件/网络副作用不能回滚。配额、保留期与历史索引已在第四轮继续实现，大量任务产生的当前状态仍会增加恢复基线体积。飞书真实网络端到端验证及 Linux/macOS 平台实机验证未在本轮进行。

恢复性能可在构建后运行 `npm --prefix tui-ink run benchmark:session` 复测；默认生成 4001 条、约 17.4 MB 事件，产物保留在仓库 `.test-tmp/`，不使用系统临时盘。可用 `-- --events=数量` 调整规模，或用 `SPAWN_BENCHMARK_DIR` 指定输出父目录。本机 Windows 温缓存测量为快速恢复约 3.8 ms / 0.60 MB 读取，全量重放约 91 ms / 17.4 MB 读取；这是本机比较结果，不是冷盘时延承诺。

## 第四轮：配额、保留期和历史检索索引

原始运行日志和长期记忆分开保留。清理旧分段前先验证原始哈希链，把用户输入、完整历史消息、约束、决策、任务、工具证据等记录保存到带校验和的 gzip 记忆归档，再原子发布 `retention.json` 与 `retention.backup.json` 两份恢复基线。基线包含当前目标、所有会话绑定、近期上下文、未完成任务、待核对工具和未确认收件箱。两份基线写入并回读验证后才删除原始分段，删除中断可重试。旧的逐帧状态/心跳等诊断噪声可过期；这不是保留原始调试轨迹的无损备份。

清理后恢复从保留基线接上后续日志，历史细节由 `SessionRecall` 跨记忆归档检索，原始事件序号和目标版本保持不变。一份基线损坏时使用另一份；两份均损坏时停止恢复，不会悄悄启动空会话。长期记忆归档缺失会阻止恢复，读取时校验失败会明确报错。基线与归档仍应纳入用户自己的备份。

索引按不可变分段/记忆归档独立保存，使用字符三元组 Bloom 过滤候选事件，再对原文做精确子串匹配。支持中文、英文及多个查询词；很短的词和过滤器误报会退回候选扫描。索引缺失、过期或损坏可从源数据重建，不能代替记忆源。检索一次只持有一个源文件句柄，轮转或清理期间会定位到同一序号范围的归档。索引缓存可被配额淘汰，查询按最新事件优先并在达到结果数后停止。

默认配置如下，环境变量单位均为字节或毫秒，可设为 0 进行立即回收/禁用缓存：

| 环境变量 | 默认值 | 管理范围 |
| --- | --- | --- |
| `SPAWN_LOG_MAX_BYTES` | 64 MiB | 活动文件与原始分段的回收目标 |
| `SPAWN_LOG_RETENTION_MS` | 30 天 | 超过保留期的原始分段转为长期记忆归档 |
| `SPAWN_INDEX_MAX_BYTES` | 32 MiB | 可重建的历史检索缓存 |
| `SPAWN_STORAGE_MAX_BYTES` | 256 MiB | `.spawn/events/` 总体存储目标，优先淘汰缓存和可清理日志 |
| `SPAWN_PROCESS_RETENTION_MS` | 7 天 | 已归档、已终止的命令进程记录 |
| `SPAWN_PROCESS_MAX_BYTES` | 8 MiB | 可清理的已终止进程记录配额 |

PM 启动后约一分钟维护一次，分段完成后约一秒触发维护。压缩、索引构建和文件 I/O 异步进行，准备阶段会让出事件循环；只在发布恢复基线等短步骤持有写锁。维护期间可继续与 PM 提问和改变目标；准备期间新增的输入从后续日志恢复，旧基线不能覆盖新目标。

TUI 中 `/storage` 查看状态，`/storage clean` 立即异步维护。也可在构建后运行：

```powershell
npm --prefix tui-ink run storage:session -- --root=E:\spawn-work
npm --prefix tui-ink run storage:session -- --root=E:\spawn-work --clean
npm --prefix tui-ink run benchmark:history
```

状态报告保存在 `.spawn/events/storage-status.json`，包含实际占用、清理错误和配额压力；删除失败的原始文件也计入占用。只删除已核实的受管理普通文件，不跟随链接、不递归删除未知内容；运行中、阻塞中或内容不明的进程记录保留。原子写入残留和半写尾部副本至少留存一天，再按保留期清理。基准数据保留在仓库 `.test-tmp/`，默认不写系统临时盘。

配额不是“删记忆直到磁盘低于上限”的硬限制：长期记忆与恢复基线受保护，自身超过目标时报告 `overQuota`，保留数据并提示处理。维护存在短暂的写入/准备空间开销，也不能管理整个仓库、旧诊断通道或系统临时目录中的任意日志。用户应留出磁盘空间，不能用该机制代替文件系统容量监控。

验证包含 `session-round4.test.ts`：配额/保留期、完整早期记忆、待处理输入/工具/收件箱、基线单副本恢复、物理删除失败重试、索引重建与精确结果对照，以及归档、首份基线和部分删除三个强杀窗口。构建后的程序还使用真实 `k3` 模型验证了部分删除时强杀后重启，旧记忆、最新目标及未确认操作均保留。

仍有不足：受保护记忆持续增长时需要扩容或明确的业务归档/删除策略；两份基线和记忆归档都在本地，无法抵抗磁盘损坏。索引是可淘汰的词面过滤，不提供语义检索；冷索引重建、大量分段及短查询仍可能较慢。清理后的旧诊断轨迹不能完整重建。飞书真实网络端到端验证及其他操作系统实机验证仍未覆盖。

## 第五轮：独立备份、冷检索与可追溯交接

日志清理现在要求先完成独立备份；备份失败时保留原始分段并在维护报告中说明原因。在线备份短暂锁定事件边界，固定恢复基线、不可变归档/分段及已提交的活动尾部，然后异步上传到独立目录。备份对象按 SHA-256 去重，发布恢复点前同时验证对象字节、归档逻辑校验和、原始事件哈希链和最终序号。不会仅因文件大小相同就认定归档完好。旧快照引用的对象保留；无引用的上传残留至少留一天。

默认备份父目录为工作目录加 `-backups`，再按工作目录哈希区分工作区。例如工作目录为 `E:\spawn-work`，备份就在 `E:\spawn-work-backups\<hash>`，不会默认写入 C 盘。`SPAWN_BACKUP_DIR` 可指定其他备份父目录；`SPAWN_BACKUP_KEEP` 默认保留最近 5 个有效恢复点，最小为 1。相同内容/序号不会重复生成恢复点。`/backup` 在线创建，`/backup list` 列出恢复点，期间可继续向 PM 发消息。

构建后可用独立 CLI。下例的 `--root` 必须指向实际包含 `.spawn` 的程序工作目录；若程序从 `E:\spawn-work\tui-ink` 启动，则相应改为该路径。

```powershell
npm --prefix tui-ink run backup:session -- create --root=E:\spawn-work
npm --prefix tui-ink run backup:session -- list --root=E:\spawn-work
npm --prefix tui-ink run backup:session -- verify --root=E:\spawn-work
# 先退出目标工作区的程序；精确修复损坏归档，不回滚新目标与后续日志
npm --prefix tui-ink run backup:session -- repair-archives --root=E:\spawn-work
# 将备份恢复到空工作区；可用 --id=恢复点ID 指定版本
npm --prefix tui-ink run backup:session -- restore --root=E:\spawn-work --to=E:\spawn-recovered
```

完整恢复默认拒绝覆盖已有事件目录；确需替换时显式加 `--replace`，旧目录移到 `.spawn/events.before-restore-<uuid>` 保留。恢复先在暂存区校验，再写持久恢复事务并切换目录。中途退出后，正常启动会提示未完成恢复；重新执行相同 restore 命令续完事务。最新恢复点对象损坏时，自动选择较旧的有效恢复点，并在结果中明确返回 `fallback`、实际 `id` 和 `latestAvailable`，需要核对回退范围。修复归档只接受与当前基线精确匹配的副本，不会静默退回旧目标。运行与恢复共用工作区所有权锁，避免一边恢复一边执行任务。

备份覆盖事件来源、恢复基线和长期记忆；代码文件、产出文件、配置、凭据与旧秘书私有快照不在该备份范围内。恢复后的统一上下文从事件状态和历史检索取得记忆；已经发生的外部副作用仍需核对。将备份复制到另一台机器时，保留其 `objects/` 与 `snapshots/`，用原 `--root` 值定位工作区哈希，并把 `SPAWN_BACKUP_DIR` 指向复制后的父目录。

检索增加持久的源目录 Bloom 摘要，先排除不相关归档，再打开候选源的事件索引，减少大量小文件打开。缺失/损坏索引时直接精确扫描返回结果，每个工作区最多并发 2 个后台重建任务；单次维护最多补齐 64 个未覆盖源，避免反复维护同一批尾部分段。目录与事件索引都是可淘汰缓存，损坏或指纹不匹配时回退源数据；短词仍可能需要全扫描。目录摘要按需加载，带校验和，跨进程重启生效。

### 默认分工与组织层级的折中

- `adaptive` 为默认：简单任务由 PM 自己完成；较长且边界清楚的工作直接 PM → Worker，PM 保持用户对话。需要协调多个工作流时才用 PM → Leader → Worker；默认拒绝 Leader 再创建 Leader。
- `hierarchical` 保留为显式选项，适用于确实需要独立负责人协调的工作；`single` 完全不创建子 agent。通过 `SPAWN_ORCHESTRATION` 选择。秘书、任务记录、恢复和历史查询不依赖组织层级，不必为记忆而增加管理 agent。
- 子任务停止时保存停止原因、自报验收证据、交接摘要、未完成 TODO、产物路径与最后错误。PM 可用 `TaskStatus` 查询；大量任务按 `nextOffset` 翻页，或用 `agent` 精确定位，长证据用 `SessionRecall`。子任务的 `success` 仍需独立验收。
- 修复了两个静默丢失窗口：工具尚未执行/返回时的提前完成会被拒绝；PM 一轮回复显示 done 后仍会接收子任务终止通知。通知先持久入队，即使父 PM 暂未在线也可在恢复后读取；失效的中间负责人会向上转交到仍可接管的 PM。旧需求版本的结果不能唤醒新任务。
- 对只汇报后停在 idle、TODO 未完成却报告成功、模型请求最终失败及执行预算耗尽，采用有限次纠正后失败交接。停止后清掉排队的内部请求，不再默默占用模型调用。由 PM 根据证据决定续派或换方法，不把每次执行错误都转成用户必须选择的四选一。

`session-round5.test.ts` 覆盖在线尾部快照、独立恢复、归档精确修复、损坏恢复点回退、备份失败不删日志、恢复切换中断、运行/恢复互斥、同大小归档损坏、冷索引/跨进程目录、分页任务追溯、提前完成及静默停止等场景。真实 `k3` 已验证：CLI 修复损坏归档并恢复到新目录，恢复后检索早期中文记忆与失败任务；PM 直接派真实 Worker 写文件/Read 核对，执行中继续接受追问，结束后接收持久交接。测试使用隔离的 E 盘工作区，未走飞书真实网络，也未覆盖完整人工 TUI 操作。

基准可复测：`npm --prefix tui-ink run benchmark:history -- --events=1200 --segment-bytes=1024`。本机生成 1201 条事件、401 个归档：归档全扫描约 291 ms，新 Node 进程读取目录并检索约 31 ms，打开 1 个源、跳过 400 个；源与索引约 1.9 KB，目录约 96.6 KB。同进程热查询约 4.9 ms。索引完全缺失时扫描原始日志约 412 ms，同时只排队 2 个重建任务。文件系统缓存是热的，规模和数据分布会改变表现，不是冷盘承诺。

仍有不足：默认备份与工作区同盘，不能抵抗磁盘故障；需要将 `SPAWN_BACKUP_DIR` 放到其他卷或自行同步。恢复点有数量限制，备份对象、受保护记忆及恢复隔离目录没有总字节硬配额，长期增长仍需管理。大基线/大量归档的完整备份校验有线性 I/O 开销，目录摘要也尚未分片，首次无索引与短词检索仍较慢。任务自动续派策略依靠 PM 判断，尚无确定性的重试预算/验收调度器；跨 Worker 文件写入冲突仍需靠任务边界约束。极短的所有权切换或锁文件写入窗口若被强杀，可能留下不完整锁，系统会拒绝猜测并要求人工核查。其他操作系统实机、飞书真实链路与磁盘断电一致性仍未覆盖。

## 第六轮：持久续派预算、独立验收与 Worker 定位

第五轮中依赖 PM 自行判断重派次数的部分，改为运行时控制的逻辑任务。任务 ID 根据会话、需求版本和规范化目标生成，与 Worker 的临时 ID 无关。一次任务的后续尝试共享次数、轮数、模型请求数、工具数和总时限，换 Worker ID 或重启程序不能归零。已验收、已耗尽、正在评估或正在续派的目标不能通过再次 spawn 重做；原任务用 `TaskRetry` 申请继续，明确的新需求才进入新版本。不同目标也受会话当前版本总计 12 次 Worker 派工约束，可通过 `SPAWN_TASK_ATTEMPTS_PER_REVISION` 配置为 1–100。

默认任务预算与可选的 `dispatch.recovery` 字段：

| 字段 | 默认值 | 硬上限 |
| --- | --- | --- |
| `mode` | `auto` | 可改 `manual`，只暂停后续续派 |
| `max_attempts` | 2 次，包含首次 | 3 次 |
| `max_turns` | 40 个运行轮次，含网络重试状态 | 80 |
| `max_requests` | 60 次实际模型请求，包含 HTTP 重试 | 120 |
| `max_tools` | 80 次 Worker 工具实际执行 | 160 |
| `total_ms` | 首次派工起 20 分钟，含等待/退避 | 60 分钟 |

自动续派仅用于已确认有新进展的可恢复停止、验收未通过，或可识别的临时网络/服务错误。权限/凭据错误、主动取消、没有新进展或不明确的阻塞交给 PM 核查，不会无限刷调用。先持久化续派预约和下一尝试 ID，再启动 Worker；退避等待期间可继续与 PM 沟通。运行中有总时限保护，验收测试也使用剩余时限。预算耗尽会明确记录 `exhausted`，不会自动放宽。组织策略冲突直接交给 PM；容量不足的等待受原总时限约束。

续派前先等待旧工具取消及孤儿进程恢复完成，核对操作凭据。Write/Edit 完成后记录文件哈希；后续尝试发出相同操作且文件仍匹配时，复用已确认结果，不再次写入。文件被其他操作改动时阻止自动重做。命令成功也不代表其外部副作用可自动重放，因此 Bash/测试等无法用文件哈希完整描述的操作，默认需要 PM 核查。状态不明的写入或命令也会阻止自动续派。

PM 工具如下，Worker 无权调用控制/验收工具：

| 工具 | 用途 |
| --- | --- |
| `TaskStatus(agent?, task?, offset?, limit?)` | 查看停止交接、逻辑任务预算、验收结果；传 `task` 分页查看操作凭据 |
| `TaskRetry(task, reason)` | 提供具体的新方案，在原预算内申请续派，不能直接绕过不确定副作用 |
| `TaskPolicy(task, mode)` | 暂停/恢复后续自动续派，不重置预算、不打断当前 Worker |
| `TaskReconcile(task, operation, evidence, reason)` | PM 使用新鲜的独立工具调用 ID，记录现场核查与“不得重复”决定；再推进剩余工作 |
| `TaskReview(task, verdict, evidence, rationale)` | PM 独立验收或拒绝；证据必须来自最新 Worker 停止后的实际检查，不能自报或复用旧证据 |

`evidence` 为逗号分隔的独立检查调用 ID。TaskReconcile 是可追溯的 PM 人工判断，不是对外部系统的数学证明；它不会自动重新执行旧命令。已核查为“不得重复”的相同命令再次出现时，返回核查记录并跳过。自动验收与 PM 接受都不能覆盖已经失败的机器检查。TUI `/tasks` 查看当前会话预算，`/tasks pause [taskId]` 暂停后续自动续派，`/tasks resume [taskId]` 恢复；省略 ID 对当前会话全部任务生效。暂停期间总时限仍继续计时。`/pause` 中断所选 Worker 时会留下主动停止记录。

`agent.done(success:true)` 只是自报完成。运行时验收状态独立为 `evaluating`、`awaiting_review`、`accepted` 等。可在 dispatch 中声明机器检查，每个 criterion 对应 acceptance_criteria 中从 0 开始的序号：

```json
{
  "background": "实现并验证结果文件",
  "constraints": ["只修改指定文件"],
  "acceptance_criteria": ["结果包含完成标记", "项目测试通过"],
  "stop_conditions": ["agent.done"],
  "worker_profile": "implement",
  "recovery": {"mode":"auto","max_attempts":2,"max_requests":20},
  "acceptance_checks": [
    {"criterion":0,"type":"file_contains","path":"result.txt","value":"FINAL"},
    {"criterion":1,"type":"test_suite","path":"."}
  ]
}
```

支持 `file_contains`、`file_sha256` 和 `test_suite`。文件检查最多读取 8 MiB 普通文件，路径不能越出工作区，包括链接解析后的路径。`test_suite` 由控制器在 Worker 停止后独立运行项目测试，严格要求解析到通过测试、且执行成功；空命令的退出码 0 不算通过。每次尝试的验收调用有稳定 ID，恢复时不会盲目重复不确定的验收命令。所有验收标准均有覆盖且检查通过，才自动进入 accepted；未提供完整机器检查的主观标准仍需 PM 新鲜证据与评审理由。测试命令由项目现有配置检测，不执行模型随口生成的验收命令。

### 与 OMO 角色分工的关系

借鉴按任务能力分工，不照搬固定角色名或固定链路，不引入 OMO 依赖。仍保留 PM → Worker 的直接派工；Worker 的定位是 dispatch.worker_profile 配置，同一套持久生命周期与预算适用于所有定位：

| 定位 | 工作与工具范围 |
| --- | --- |
| `implement` | 修改实现、执行任务、提交可核对证据 |
| `research` | 读文件、搜索与检索，不允许写入/执行命令 |
| `review` | 只读审查与证据整理，不修改被审查实现 |
| `verify` | 读与检索、RunTests、TypeCheck；不能 Write/Edit/Bash 修改实现 |

只有任务确实需要时才派对应定位，不要求调研、实现、审查、验证每种都创建一个 agent。profile 限制不是 OS 沙箱；项目测试自身也可能写文件或访问外部系统。秘书、事件、预算、验收、重启恢复独立于这些定位和管理层级。复杂协同仍可显式选择 hierarchical；负责人失效且分层策略不允许直接续派时，会交给 PM 调整安排，不悄悄违反组织策略。

验证：`session-round6.test.ts` 包含自动续派去重、错误完成拒绝、有限重试、需求变更隔离、暂停/恢复、网络请求预算、独立验收、归档/备份/跨进程预算、人工副作用核查、严格测试套件、验收中断及伪造协议结果拒绝等 20 项测试。全量 660 项中 653 通过、7 项原有 TODO、0 失败；headless 82 通过，类型检查与构建通过。验收证据必须有实际工具执行来源，模型输出的 tool.result 不能伪造独立验收。真实 k3 使用隔离 E 盘工作区验证：首次写入部分结果后强杀程序，重启自动续派，旧 Write 经哈希核对后不再执行，继续 Read/Edit 完成文件，独立文件 SHA-256 与实际 Node 测试均通过；期间 PM 可回答追问。共使用 2 次尝试，预算与凭据跨重启保留。真实验证使用受控故障注入提示词与真实模型/工具，不等于对任意自然任务的全覆盖验收。

仍有不足：预算约束主要覆盖受管理的 Worker，PM 自己和传统 Leader 的总花费尚无统一金额/Token 上限；自动验收依赖事先约定标准和项目测试质量，不能自动证明复杂业务正确；测试输出解析有框架覆盖边界，严格模式可能拒绝不识别的输出格式。外部副作用核查依赖 PM 证据判断，无法保证网络请求恰好执行一次；命令语义改写也无法全部识别为同一操作。并行 Worker 仍共用工作区，未实现文件锁/隔离工作树，验收是某一时刻的结果，后续修改可能使其过期。完全耗尽后需用户明确调整需求，暂不支持在同一版本内人工增加预算。历史任务/操作凭据仍会增长，完整人工 TUI、飞书真实网络和其他系统实机未在本轮覆盖。


## 第七轮：统一预算与并行文件隔离

默认仍为 PM 直接派 Worker、持续接受用户消息，组织层级可选。本轮不依赖 OMO。此前第六轮列出的 PM 总预算和并行共用文件问题已由以下机制替代。

### 持久总预算

PM、传统 Leader、Worker、续派、根会话和分支共用当前项目 `.spawn` 内的一个累计预算池；切换需求版本、换 Worker ID、重启都不清零。每次 HTTP 请求先预留输入和输出额度并限制 max_tokens，每次工具调度先扣额度；供应商返回有效用量后结算。断流、强杀或缺少用量时保留全部预留量，宁可提前停，不把未知账单视为零。旧任务迟到的结算也会记账。工具额度统计调度尝试，包含失败或去重命中的调度。BudgetStatus、TaskStatus 和任务治理查询不消耗工具额度。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| SPAWN_SESSION_MAX_REQUESTS | 200 | 全项目受管理模型请求总次数 |
| SPAWN_SESSION_MAX_TOKENS | 2000000 | 输入、输出与未结算预留总 Token |
| SPAWN_SESSION_MAX_TOOLS | 400 | 工具调度次数 |
| SPAWN_COMMUNICATION_REQUESTS | 8 | 在上述总额内预留给用户追问的请求 |
| SPAWN_COMMUNICATION_TOKENS | 64000 | 在上述总额内预留沟通 Token，最多总额四分之一 |
| SPAWN_SESSION_MAX_USD | 0 | 可选估算金额上限，0 为未启用金额限制 |
| SPAWN_INPUT_USD_PER_MILLION | 0 | 显式配置的每百万输入 Token 美元估价 |
| SPAWN_OUTPUT_USD_PER_MILLION | 0 | 显式配置的每百万输出 Token 美元估价 |

金额上限必须同时提供两项价格；不自动猜测厂商价格。价格为本地估算，并非供应商账单承诺。首次初始化后改变环境变量不会重置已持久化额度；预算耗尽时用本地命令显式追加：

```text
/budget
/budget add requests=20 tokens=100000 tools=40
/budget add usd=1
/contextbudget 100k
```

`/budget` 为离线总额度状态，`add` 只增加上限，不清零消耗，模型没有追加额度工具。旧的 Token 展示告警命令改名 `/contextbudget`，不参与硬预算。预算耗尽后用户仍能获得本地状态；有限沟通余量允许 PM 解释进度，但不能派工、调用工具或修改状态。余量耗尽后不会为聊天无限请求模型。

计数写入事件和 `.spawn/budget-floor.json`。同项目恢复旧事件备份时保留本地已知消耗，不能靠回滚备份退回额度。恢复到全新目录时无法推断原目录在备份之后的费用，需核对供应商账单并迁移预算底账。删除整个 `.spawn` 或启动项目外的其他程序不受此预算管理。

### 私有快照、验收与冲突

新任务默认 `SPAWN_WORKSPACE_ISOLATION=snapshot`，在 `.spawn/workspaces/<task>/<uuid>/tree` 拷贝普通项目文件；同一逻辑任务续派复用原副本。历史旧任务维持原来的 shared 语义，不能追溯隔离已发生的写入。仅操作者可设置 `SPAWN_WORKSPACE_ISOLATION=shared` 关闭新任务隔离，模型派工参数不能关闭。

Worker 的文件工具、相对路径命令与测试在私有副本执行，原目录在验收后才发布。PM 用 `Read(path,task)`、`RunTests(project_dir,task)` 或 `TypeCheck(project_dir,task)` 查看和测试目标副本；人工验收拒绝拿原目录的旧内容当证据。发布先检测全部差异的基线与当前哈希，不同文件可合并，同文件冲突会保留双方并阻塞，不自动重派覆盖。续派前也检查已知冲突，避免为冲突消耗新尝试。

PM 先用 WorkspaceStatus(task) 和 Read 检查双方。WorkspaceResolve(task,path,expected,choice) 要求当前原目录的精确 SHA-256（不存在为 missing）；ours 保留任务版本，theirs 保留原目录。只在目标没有再次变化时记录解决，然后 WorkspacePublish(task) 显式发布。解决或发布本身不意味着业务验收通过。

发布事务先持久记录每个文件的 before/after 哈希；强杀后逐文件幂等恢复。外部改动导致恢复冲突时只阻塞相关任务，其他状态查询和 PM 沟通继续可用。需求已过期的待发布事务会持久放弃，保留现场供检查，绝不继续完成旧需求。多文件发布不是文件系统原子事务，中途已发布的文件不会擅自回滚。

快照排除 `.git`、`.spawn`、`node_modules`、`.test-tmp`、`.venv`、`venv`；遇到链接或特殊文件拒绝建立快照。默认最多 10000 文件、128 MiB，可用 SPAWN_WORKSPACE_MAX_FILES、SPAWN_WORKSPACE_MAX_BYTES 显式调整。依赖没有复制，Node 可以沿父目录查找现有依赖；其他语言和工具可能需要额外配置。

### 验证与当前边界

专项测试覆盖共享预算、重启与需求变更不退额、未知用量、金额、旧备份底账、并行冲突、不同文件合并、私有命令目录、人工验收版本、发布中断、恢复时外部冲突、过期事务、PM 沟通余量和离线预算命令。旧轮次需要即时共享文件的回归夹具显式设为 shared；第七轮专项验证默认 snapshot。

真实 k3 验证使用受控提示词、真实 HTTP 与工具，报告保存在 E 盘 `tui-ink/.test-tmp/live-round7-*/real-verification.json`：强杀后恢复续派，复用已核对的 Write，独立 SHA-256 和实际 Node 测试通过后发布；两个并行 Worker 修改同一文件，一方成功、一方冲突，双方内容保留，PM 期间正常回复；3 次模型请求总额含沟通预留，第四次追问仅返回本地预算状态，不新增模型请求。这些不是任意自然任务的全面成功率评测。

仍有不足：快照是工作副本隔离，不是 OS 沙箱；任意 Bash、测试或显式绝对路径可能访问副本外部或外部系统，无法保证外部副作用恰好执行一次。Windows 上已实际验证，其他系统尚未实机验证。内容哈希没有完整覆盖文件权限、可执行位和重命名语义；大项目复制有磁盘和 IO 开销，工作副本/中断草稿尚无自动回收配额。事件记忆备份包含任务元数据，但不包含这些项目文件副本，跨目录恢复需另外备份项目及 `.spawn/workspaces`。金额依赖用户估价与供应商上报，不能代替账单硬限额；旧任务仍可能使用共享工作区。复杂业务验收、真实飞书网络及完整人工 TUI 体验仍需要补充验证。


本轮最终验证：全量 676 项，669 通过、7 项原有 TODO、0 失败；headless 82 项通过；TypeScript 类型检查、构建和差异空白检查通过。可复现的真实模型脚本为 `tui-ink/scripts/verify-round7-{recovery,parallel,budget}.mjs`，从 tui-ink 执行 `npm run test:live:round7`（使用现有模型配置并消耗真实 API 额度，不在普通测试中自动运行）。脚本只在项目 `.test-tmp` 建立独立工作区，关闭服务/飞书外发，结束后保留验证报告。


## 订阅/API 分账与按定位选择模型（OMO 风格）

本实现借鉴 OMO 的“定位 + 有序候选模型链 + 独立提供商通道”，不引入 OMO 整套运行时或固定角色层级。调研、实现、审查、验证仍是 Worker 的定位，PM 直接协调与持续沟通保持不变。

OMO 源码核对基于 `code-yeongyu/oh-my-openagent@657a02ef48cc6653ba845f0bb8c71b1097a64aa2`：`packages/omo-senpi/src/components/side-panel/usage/` 分别管理 Claude/Codex 订阅滚动窗口、比例、重置时间、共享缓存与请求退避；`side-panel/store.ts` 对结束的子任务成本去重累计；`docs/reference/features.md` 区分 chatgpt-subscription 与 openai API，并使用候选链。它的用量展示不等于自己向用户结算厂商账单。spawn 使用相同的分类思想，自行实现与现有持久任务/预算兼容的适配层。

### 已接入的通道

| 接入 | 模型配置 | 认证 | 本地费用展示 |
| --- | --- | --- | --- |
| Claude Pro/Max | transport=claude-cli，billing.mode=subscription | 已安装的官方 Claude Code 登录 | 记录订阅请求与 Token，不把 CLI 的 API 等价估价当新增账单 |
| ChatGPT/Codex | transport=codex-cli，billing.mode=subscription | 官方 Codex CLI 的 ChatGPT 登录 | 同上；账号支持的模型名由官方 CLI 决定 |
| OpenAI/Anthropic/兼容 API | transport=http（默认），billing.mode=api（默认） | 对应 API Key 与接口 | 按该模型显式价格或环境变量兜底价格估算 |
| 提供受支持 HTTP 接口的 Coding Plan | transport=http，billing.mode=subscription | 套餐专用 Key 和对应接口 | 按订阅用量记账，不套用逐 Token API 单价 |

Claude/Codex 推理认证由官方 CLI 保存和刷新凭据，第八轮推理接入不读取或复制令牌文件；第九轮新增的 Claude 余量查询凭据读取方式见下文。每次使用前检查登录类型，拒绝 API-key 登录冒充订阅；子进程移除继承的 API Key、替代端点/云提供商配置。CLI 子进程由现有监督器管理，取消、强杀和孤儿清理使用同一恢复机制。CLI 会话不持续保存，spawn 仍负责长会话事件、当前状态及历史上下文。

Claude 使用单轮、无内置工具、无 MCP、无用户/项目设置的 print 模式，并设置输出上限。Codex 使用临时会话、read-only、忽略用户配置、禁用 shell/并行 agent/插件/应用/浏览器等能力；只接收文本/推理和一个最终 turn，发现内部工具结果时拒绝当作有效完成。真正的工具执行都通过 spawn 的任务副本、预算和验收机制。

### 注册、分配与降级

```text
/connect claude-main claude-subscription sonnet
/connect codex-main codex-subscription <该账号支持的模型ID>
/route pm claude-main codex-main k3
/route implement codex-main claude-main k3
/route research claude-main k3
/route review claude-main codex-main
/route verify codex-main claude-main
/route
/budget
```

其中 k3 是你已有的模型注册名，示例不会自动创建 API Key。候选顺序由用户决定，不硬编码“最新模型”或假定登录就拥有所有模型。未配置定位链时保留已有角色模型配置。`/route <定位> off` 恢复角色默认模型。`secretary` 是预留的模型定位；当前秘书主要进行本地状态/记忆整理，不因为配置候选链而新增付费请求。

每个模型保留完整的 provider、model、transport、billing 和凭据，切换候选时整体切换，避免只换模型名却继续使用另一家的 Key。设置定位链后，派工中的模型覆盖必须属于该链，不能让 Worker 绕开订阅计费策略。

订阅之后的 API 候选默认跳过。只有操作者执行 `/route api-fallback on` 才允许在订阅失败后转向 API；`/route api-fallback off` 关闭。以 API 开头的定位链属于操作者主动指定 API 首选。配置修改对新启动/恢复的 agent 生效；运行中的 agent 不热切换配置。

登录、限流、模型不存在、服务不可用等可用性失败，可以沿允许的链降级；取消、总预算耗尽、无效协议或工具拒绝不能靠换模型绕过。单次发送最多 4 个受管理尝试，不无限遍历。所有通道和降级都计入原来的项目总请求/Token/工具/续派额度。每次选择与降级写入 model.selected/model.fallback 事件，可通过 SessionRecall 检索。没有成功的订阅候选、且不允许 API 降级时暂停并向 PM 交接。

### 费用与额度的边界

`/budget` 的 byBilling.api 与 byBilling.subscription 分开展示请求、Token 和本地 API 估价；总池仍统一约束两种方式。未定价 API 请求在 unpricedApiRequests 标记为未知，金额 0 不表示免费。缺少供应商用量的调用保留完整预留，历史备份回滚不返还本地已知消耗。

```text
/billing <已注册模型名> api <输入美元/百万Token> <输出美元/百万Token>
/billing <套餐专用模型名> subscription
```

API 每模型价格优先于 SPAWN_INPUT_USD_PER_MILLION、SPAWN_OUTPUT_USD_PER_MILLION。缓存输入目前按完整输入单价保守估算，未实现各厂商缓存折扣账单对账。订阅的套餐费、滚动额度和额外用量付费由厂商管理，microUsd=0 仅表示没有本地逐 Token API 估价，不承诺真实新增费用为零。若官方账户开启订阅超额付费，需在厂商侧管理。

当前未抓取厂商私有额度接口，套餐剩余百分比/重置时间显示为未知，不伪造套餐余额。尚无跨项目共享的订阅额度缓存、账号轮换或 Copilot 的原生订阅适配器；Copilot 不能仅凭设置 billing.mode 就当作已接通。后续可在现有注册表与候选链下增加提供商适配器。CLI 内部网络重试对 spawn 不透明，计数单位为一次受管理 CLI 调用，而非承诺等于一次底层 HTTP；Codex CLI 没有在本实现中提供严格的单次输出 Token 上限，实际用量结算后会阻止后续超预算执行，单次可能超过预留。CLI 有统一超时和监督器取消，金额/额度的最终硬限制仍应配置在提供商侧。

验证：新增计费/路由专项 23 项通过；全量 699 项中 692 通过、7 项原有 TODO、0 失败；headless 82 项通过，类型检查与构建通过。真实 Claude 订阅、ChatGPT/Codex 订阅分别验证文本调用；真实“Claude 订阅 PM + API Worker”与“ChatGPT/Codex 订阅 PM + API Worker”均验证定位路由、执行期间追问、私有副本、独立 SHA-256 验收和发布以及分账。可选真实验证：

```text
npm run build
node scripts/verify-subscription.mjs claude sonnet
node scripts/verify-subscription.mjs codex <该账号支持的模型ID>
node scripts/verify-billing-mixed.mjs
node scripts/verify-billing-mixed.mjs --codex <该账号支持的模型ID>
```

这些命令消耗真实额度，需要已有官方 CLI 登录和 API Worker 配置，证据保留在项目 E 盘 `.test-tmp/live-*` 中，不随 Git 上传。


## 第九轮：Copilot、厂商余量与 Codex 调用约束

继续使用 OMO 风格的按定位候选链，不增加固定管理层级。保留 PM 直接派 Worker、执行期间追问、持久预算和隔离副本。

### Copilot 订阅接入

新增 `copilot-sdk` 通道和 `copilot-subscription` 注册方式。固定依赖 `@github/copilot-sdk@1.0.23`、`@github/copilot@1.0.100`，CLI 位于项目 node_modules 内；本轮安装和 npm 缓存均在 E 盘。官方 SDK/CLI 负责 GitHub 登录和订阅认证，清除继承的 GH_TOKEN、GITHUB_TOKEN、Copilot token、API Key/端点覆盖，拒绝把 BYOK/API-key 会话当订阅。

Copilot 运行在监督器拥有的独立进程树内。SDK empty 模式关闭项目配置发现和自定义指令，不提供内置/MCP 工具，所有权限请求拒绝；模型必须属于账号返回的模型列表。传入模型输出上限，检查实际用量；发现额外模型调用、内置工具执行或超额时中止，并将可用的实际用量交回持久总预算，不自动转向 API。

从 `E:\spawn-work\tui-ink` 执行（现在没有账号时不必登录）：

```text
npm run build
node scripts/copilot-login.mjs
node scripts/verify-copilot.mjs <账号支持的模型ID>
```

默认账号数据在当前项目 `.spawn/accounts/copilot`，可以用 SPAWN_COPILOT_HOME 指定固定 E 盘目录，供多个项目共用。登录脚本使用官方交互登录，spawn 不创建或购买 Copilot 订阅。验证脚本先报告 CLI 启动/认证状态；未登录时 inference=not_run、退出码 3。登录后必须提供账号实际支持的模型 ID，才继续运行 Copilot PM + API Worker 的真实端到端流程。

```text
/connect copilot-main copilot-subscription <模型ID>
/route pm claude-main codex-main copilot-main k3
/route implement codex-main copilot-main claude-main
```

订阅之后的 API 候选仍受 `/route api-fallback on|off` 控制，默认关闭；模型覆盖不能绕过配置链或预算。

### 厂商套餐余量

```text
/usage
/usage refresh codex
/usage refresh claude
/usage refresh copilot
```

`/usage` 离线读取缓存；`refresh` 异步查询，TUI/PM 不等待查询完成才能继续操作。`SubscriptionUsage` 是 PM/Worker 的只读缓存工具，不消耗推理预算，也不能购买额度、重置套餐或发送通知。

| 厂商 | 查询来源 | 展示 |
| --- | --- | --- |
| Codex | 官方 app-server account/read、account/rateLimits/read | 独立额度桶、剩余百分比、重置时间 |
| Copilot | 官方 SDK account.getQuota | 套餐包含量、剩余量/比例、无限额度、重置时间 |
| Claude | OAuth usage 端点 | 新旧格式的滚动窗口、模型专属窗口、剩余比例与重置时间；端点拒绝或变化时显示不可用 |

Claude 余量查询会在内存中只读已有 OAuth access token，并且只向固定的 Anthropic usage 地址发送；不复制令牌、不写入缓存/事件、不导出刷新令牌。Codex 由官方 app-server 查询余额，本地 auth.json 中的账号 ID 仅用于生成不可逆缓存指纹。GitHub 认证由官方 Copilot SDK/CLI 处理。

数据明确区分 fresh、stale、unknown、error；缺少字段、未登录、403、未知格式不能解释成零余额。保留上次成功数据与时间，失败后标为 stale 并附安全错误码。余额窗口的 resetsAt 是 Unix 毫秒时间。

缓存默认在 `.spawn/usage-cache`，按厂商与账号指纹隔离，不保存 OAuth token、邮箱或原始错误响应。90 秒有效期、手动刷新最短 5 秒；并发查询合并，跨进程锁和持久退避避免重复请求，429 的等待不因刷新而清零。SPAWN_USAGE_CACHE_DIR 可指定多个项目共同使用的 E 盘目录；Copilot 登录资料变化会使相关缓存失效。读取失败不阻塞正常沟通。

路由在模型调用前检查新鲜缓存；确认已耗尽且尚未重置的适用窗口会暂停该候选，并按允许的链处理，不占用新的全局模型请求额度。Claude 模型专属额度只影响匹配的 Opus/Sonnet/Haiku 等定位模型，Codex 独立桶不会被当成所有模型的公共余额。过期、失败或未知数据不作为“已耗尽”的证据；没有后台高频轮询，需主动 refresh 获得最新状态。厂商套餐余量和本项目 `/budget` 是两个不同范围的账。

### Codex 预算约束

Codex 每次调用现在使用实际编译提示词的保守输入预留、输出分配和 60 秒监督超时。输出 schema 在提供商支持的结构化输出中限制可见字符串长度，最终响应再次校验；运行中按字节增量检查 JSONL，超过输出总量、出现第二轮或内置工具时立即请求监督器取消，不等进程自然结束。

厂商返回的 input/output（含其报告的推理消耗）超过分配时，不接受该结果；按实际 Token 结算，而不是截断账单。预算错误禁止换模型/API 降级、自动续派和系统通知触发重试。暂停原因持久保存，重启后仍阻止自动调用；用户明确“继续”或提出新目标才解除执行暂停，已用总预算不清零。用户查询可使用只读沟通预留，`/budget` 与 `/usage` 的离线状态始终可用。

必须区分本地停止和远端硬上限：Codex CLI 当前没有暴露可验证的服务端单次输出 Token 上限，结构化字符串长度也不约束隐藏推理 Token。在途响应可能已经超过预留才上报。本轮真实压力验证中分配 64 输出 Token，厂商报告 175，程序拒绝结果并记录 175，后续请求受预算阻止；不会声称这 175 已被提前限制成 64。

若部署要求绝不发出缺少服务端 Token 硬上限的调用，设置 `SPAWN_CODEX_REQUIRE_HARD_TOKEN_CAP=1`：调用前拒绝 Codex CLI，不启动推理、不占用全局模型请求额度、不自动降级付费 API；由操作者选择合适的另一条通道。普通模式通过预留、输出/轮次/时间检查、完整结算和停止后续执行来限制损失，不能撤回厂商已产生的在途费用。

Codex 的宿主事件在交给执行器前整段检查 JSON 和 agent 身份；拒绝时不会执行前半段合法事件。协议错误最多允许一次同模型纠正，照常计入请求/Token 预算，不切换计费通道。另修复旧解析兜底：格式错误的 JSON 中引用 `agent.done`（例如 dispatch.stop_conditions）不能被合成为成功完成。

另外修复关闭/切换工作区的竞态：旧请求返回后不再向新工作区发布响应或结算预算，原工作区的不确定预留继续保留。

强杀恢复时，监督进程可能在记录读取后完成清理并退出；恢复器会重新读取最终记录，避免误报孤儿进程。仍无明确终止证据时保持阻断。

### 本轮验证

新增专项 24 项：额度格式/模型范围/未知状态、缓存与退避、账号隔离、Codex 运行中取消/额外轮次/内置工具、输入与输出约束、实际消耗与沟通余量、预算暂停跨重启、严格拒绝模式、旧响应隔离、Copilot 文本模式/未登录/超额停止。

全量 723 项：716 通过、7 项原有 TODO、0 失败；headless 82 通过；类型检查、构建和差异检查通过。真实验证包含 Codex 余量查询、结构化输出、受控超额拒绝、3 次总额度含 PM 沟通预留、没有第 4 次模型调用，以及 Codex PM + API Worker 执行期间追问/独立验收/发布。脚本：

```text
node scripts/verify-round9.mjs <账号支持的Codex模型ID>
node scripts/verify-billing-mixed.mjs --codex <模型ID>
node scripts/verify-copilot.mjs <Copilot模型ID>
```

本机真实查询 Codex 成功；Claude usage 实际返回 403，已验证不可用状态和退避，不能确认其余额。按用户选择，Copilot 本轮只验证官方运行时启动、未登录拒绝和可运行 E2E 脚本，没有完成有账号的真实推理与余额验收。凭据、临时项目和验证报告仍在 E 盘忽略目录，不上传 Git。

仍有不足：厂商在途费用无法撤回；Codex 普通模式不是远端硬 Token 上限。Claude 使用的 usage 端点与本地凭据文件格式可能变化，当前账号需解决 403 才能验证余额。Copilot 需要有权限的账号完成真实验收，SDK 的部分 quota 接口仍是实验接口，因此固定版本。未覆盖所有 Coding Plan 的余额接口和账号自动轮换；新鲜额度缓存可能有最多 90 秒延迟，不能代替厂商账单硬限额。多进程缓存锁过期回收采用 30 秒租期，长时间系统挂起后可能重复一次只读查询。其他平台未实机验证。

参考：[Copilot 用量接口](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)、[官方 Codex app-server](https://learn.chatgpt.com/docs/app-server)。

## 第十轮：模型、用量和预算状态

按用户要求，Claude 403 暂不排查 host；只保留简明的不可用原因。`/usage refresh` 默认只查 Codex/Copilot，不探测 Claude。`/usage refresh claude` 仍可由用户显式调用；403 显示 `usage-forbidden / HTTP 403`，不推断为登录失效、无余额或确定的 host 故障。

| 命令 | 展示内容 |
| --- | --- |
| `/account` | 离线总览：模型配置、有效候选链、工作区预算、厂商套餐缓存 |
| `/model show` | 注册模型的 API/订阅通道、模型 ID、配置检查、价格是否设置、角色默认和候选链被跳过原因 |
| `/usage` | 查询来源、新鲜/过期/未知/不可用、数据时间、重置时间、安全错误码和允许重试时间 |
| `/usage history [codex\|copilot\|claude]` | 当前账号最近 10 次查询的追踪 ID、UTC 时间、耗时、结果和 HTTP 状态；读缓存不会制造查询记录 |
| `/budget` | 总额度和执行池剩余、PM 沟通预留、API 估价与订阅消耗分列、未定价请求、未结算/不确定消耗、agent 最近实际调用通道和错误类别 |
| `/usage --json`、`/budget --json` | 保留机器可读输出；`history`/`refresh` 可与 usage 的 `--json` 组合 |

模型配置不等于登录成功，候选链不等于实际调用。新的 `model.selected` 记录投影到持久状态，重启可查看最近一次调用尝试；修改配置对新启动/恢复的 agent 生效。订阅注册误传 API Key、无效计费配置或写入失败不再显示保存成功。显示 API 端点时移除 URL 用户名、密码、路径和查询参数；不显示 API Key。没有模型价格时明确提示可能使用会话估价，不显示为免费；订阅 Token 不换算成厂商套餐剩余或订阅账单。

额度失败记录保存在原有账号隔离缓存中，退避和最后成功数据跨重启保留。旧数据只供参考，不能当作当前额度；查询失败不会阻断 PM 的正常沟通。记录不保存原始错误响应、令牌或邮箱。Copilot 继续保留“待登录验证”，没有用未登录启动结果冒充真实推理成功。

验证：新增 10 项专项测试，全量 **733 项：726 通过、7 项原有 TODO、0 失败**；headless 82 项通过，类型检查与构建通过。真实验证未查询 Claude，Codex 余量查询成功，Copilot 明确返回未登录；真实 Codex PM + API Worker 完成执行期间追问、文件写入、独立验收和发布，并验证总览里的实际通道、计费分列和凭据脱敏。运行：

```text
cd E:\spawn-work\tui-ink
npm run build
node scripts/verify-round10.mjs <账号支持的Codex模型ID>
```

仍有边界：查询历史只保留当前账号最近 10 次；更早记录没有做长期审计归档。API 金额依赖配置估价，未覆盖各厂商 API 余额查询；本地预算和订阅额度是不同数据源。Copilot 还需登录后做真实推理验收。Codex 普通模式的在途隐藏推理消耗限制同第九轮；Claude host 问题按用户要求暂不继续处理。

## 第十一轮：长期审计与 TUI 登录

### 在 TUI 中配置

运行 `E:\spawn-work\spawn.cmd`（启动前构建，避免继续加载旧 UI），输入 `/login`：

1. 用 **↑/↓、Enter** 选择账号订阅或 API Key；不再提供数字直选。
2. 搜索供应商并回车，列表标明已配置/未配置。订阅走官方客户端登录或检查已有登录；常见 API 供应商直接进入隐藏 Key 输入，自定义 OpenAI 兼容服务才需要输入地址。
3. 从可搜索的模型列表选择名称。API 使用配置地址的只读 models 接口；Codex 使用官方 app-server `model/list`，Copilot 使用 SDK 模型目录。没有推理请求。读取失败仍有预置目录，并明确显示未验证账号权限；手填 ID 只保留为高级入口。
4. 选择 PM、Worker/implement、全部角色或仅注册，确认保存。注册名自动生成，不再要求额外命名。

交互参考本机 OmO 5.1.38 的实际 `/login`、供应商搜索和 `/model`；预置目录是该版本本地目录的模型名称快照，不依赖用户安装 OMO，也不表示账号已开通其中所有模型。配置权限与模型调用能力仍由实际厂商验证。Claude 订阅目录只使用预置数据，本轮不排查 Claude host 或余量。

Key 的输入独立于聊天框和命令历史，不发给 PM，不进入事件日志；确认前只留在内存，取消清除草稿。订阅登录提示只显示在临时面板里，Esc/Ctrl+C 可取消认证，不中断后台 PM。新配置默认原子保存到当前项目 `.spawn/config/config.json`；`SPAWN_CONFIG_DIR` 仍可显式指定目录。兼容读取原用户配置，默认新写入使用项目目录。官方订阅凭据仍由官方 CLI 管理。

保存后明确列出 PM/Worker/秘书的配置。尚未启动的 PM 标题立即刷新，并可感知其他窗口的配置保存；已有运行实例保持显示其实际模型，候选降级时跟随实际通道更新，避免改名掩盖旧实例尚未切换。角色配置变更不会中途重启正在执行的任务。

### 长期账本

所有 `budget.reserved`、`budget.settled`、任务状态和停止记录继续使用 fsync 的持久事件链。新增额度查询也写入同一链：缓存仍只显示最近 10 次，但从本轮开始的查询历史不再随缓存轮换消失。沿用受保护归档、校验和与备份机制，原始日志配额清理不删除这些审计事件。

`/audit` 异步扫描事件、分段和冷归档，按实际模型/提供商/通道/计费模式、逻辑任务及需求版本汇总。Worker 多次续派归到同一个逻辑任务；PM 的协调/沟通调用单独列出未分配任务的组。保留调用时价格、已知输入/输出量、预留与结算关联 ID、未定价 API、不确定消耗、取消/额度/预算等停止类别。失败原因与结算写在同一条持久记录，避免只记费用却丢掉停止原因；拒绝发生在预留前时仍单独记录原因，不虚增模型请求数。

| 命令 | 功能 |
| --- | --- |
| `/audit` | 累计模型/任务统计与最近明细 |
| `/audit model=deepseek-flash limit=100` | 筛选模型明细 |
| `/audit task=<任务ID> before=<序号> limit=100 --json` | 分页查看任务明细及调用时价格 |
| `node scripts/session-audit.mjs --root <工作区> --json` | 离线审计，可重定向导出一个明细页 |

`before/model/task` 只筛选明细，累计分组保持全工作区统计。PM/Worker 的 `BudgetStatus` 工具增加 `audit=true` 读取同样报告，不能借此修改额度。报表固定到查询开始时的事件边界，扫描间让出事件循环；期间 PM 可继续接收消息。历史或账本校验失败时拒绝返回部分费用统计。

审计统计不受最近 200 个请求缓存的淘汰影响。旧记录缺少通道/任务信息时标为未知或未归属，不猜测。恢复旧备份后，独立的防回滚消费底线可能高于备份明细；离线审计直接校验该底线并显示差额，既不退款，也不把缺失部分伪造到某个模型/任务。原始恢复前目录保留供进一步核查。

### 验证与限制

新增 30 项专项回归；全量 **763 项：756 通过、7 项原有 TODO、0 失败**。类型检查、构建、headless 82 项通过。另用实际运行的 TUI 验证隐藏 Key、读取本地测试 models 接口、搜索 `pro`、选择模型和保存角色；未向厂商发送测试 Key。真实 Codex 账号目录返回当前可用的模型名称。

真实端到端使用用户保存的配置：**Kimi K3 PM + DeepSeek Flash Worker** 完成执行期间追问、写文件、独立验收和发布；另一次 **Codex 订阅 PM + DeepSeek API Worker** 验证分列记账。后一会话的按模型/任务统计在冷归档、独立进程重启、备份恢复后完全一致，任务验收停止类别仍可追溯。一笔取消时不确定消耗如实保留，不作为零费用。

```text
cd E:\spawn-work\tui-ink
npm run build
node scripts/verify-billing-mixed.mjs --configured
node scripts/verify-round11.mjs <账号支持的Codex模型ID>
```

尚有边界：历史查询目前扫描受保护源，没有专用审计数据库，长历史的首次查询及翻页可能较慢。查询历史从本轮新增事件开始，不能还原已丢失的旧缓存。备份消费底线差额无法自动恢复模型/任务归属。未定价 API 的美元金额未知，不能当成免费；金额仍是配置估价，不是发票。内置模型名称快照会老化，优先使用账号接口并可手动刷新。Copilot 仍待用户登录后的真实推理验收；Claude 暂不处理，Codex 在途隐藏消耗限制同第九轮。

## 第十二轮：增量审计索引与历史补价

本轮替代上节“每次审计扫描历史”的实现。运行环境在 Node **24.11.0** 验证，使用内置 `node:sqlite`；不支持该模块的旧 Node 需要升级。

### 索引、恢复与配额

`.spawn/audit-cache/index.sqlite` 保存累计模型/任务统计、分页索引、未结算关联和脱敏后的审计明细。普通追加增量更新；没有新事件时从索引读取。序号、末尾哈希、不可变来源的文件指纹及活动文件前缀哈希共同判断索引是否仍属于当前历史。索引或数据库损坏时重新校验原始账本；清理、分段轮换和恢复改变历史来源时允许重建，恢复旧备份不会沿用未来的费用明细。SQLite 事务未提交即被强杀时，下一进程回滚并重试。

首次完整读取缺失检查点的分段历史后，生成同样经过来源与边界校验的可丢弃检查点，后续启动只重放活动尾段。报告同时公开 `index.visited`（本次处理的审计事件数）、`projectionReplayedEvents` 与 `projectionBytesRead`，避免把启动尾段重放隐藏成“零 I/O”。

独立缓存配额 `SPAWN_AUDIT_INDEX_MAX_BYTES` 默认 **256 MiB**，不挤占受保护记忆的保留空间。超额时当前报告仍完整，但清空派生索引并收缩数据库；保留空 SQLite 容器的固定开销。报告 `index.retained=false` 提示下次需要重建；可按实际磁盘容量增加该配额。配额控制持久缓存，不是建索引期间临时磁盘峰值的硬限制。

`/audit --rebuild` 或离线脚本 `--rebuild` 显式重新校验全部受保护历史。普通翻页通过模型/任务/序号索引查询。索引不备份、可以删除；原始事件、价格定义、记忆和消费防回滚底线继续由原备份机制保护。后台审计分批让出事件循环，PM 仍可接收消息。

### 给缺价历史补算

```text
/price <已注册API模型名> <输入USD/百万> <输出USD/百万> source=价格来源标签 [since=ISO日期] [legacy]
/audit --json
```

使用供应商价目表或自己的代理合同价格填写，不要填 API Key。`source` 是不含凭据和查询参数的短标签，例如合同编号。省略 `since` 表示明确按该价格补算全部匹配历史；指定日期则只匹配该日期之后发起的请求。新价格默认绑定提供商、模型和端点指纹，避免同名模型在不同代理之间混价。只有显式加入 `legacy`，才允许匹配早期缺少端点信息的记录。

价格定义写入受保护事件链，包含来源、有效时间及记录时间，清理和备份恢复后仍有效；同一有效时间后录入的定义覆盖前一估价。命令也更新模型配置，供新启动/恢复的 agent 预留费用；已运行的实例继续使用其实际配置。新的调用时估价保留来源与记录时间。

`/audit` 分开显示原始调用时金额与后补估算：有实测输入/输出 Token 的未定价 API 请求可补算，并在明细中追溯价格来源。原始费用、消费底线、预留和美元预算都不会被追溯改写，也不会因补价而退款或增加可用额度。订阅不套用 API 单价；用量未知、请求尚未结算或没有可信价格时明确标记，不能推导真实账单。修改价格时会重新计算匹配的未定价索引记录一次，普通追加维护增量汇总。

### 验证与边界

新增 **15 项专项回归**，覆盖增量翻页与进程重启、损坏重建、来源变更、旧备份、价格有效期与代理隔离、旧记录显式匹配、TUI 补价命令、强杀事务回滚、索引配额和未知用量。全量 **778 项：771 通过、7 项原有 TODO、0 失败**；构建与 headless 82 项通过。

本机生成 **10 万次请求、20 万条事件**：首次校验建索引约 **7.8 秒**，随后查询约 **58 毫秒**，追加一条事件后约 **65 毫秒**；启动只重放约 **360 KiB** 活动尾段，审计数据库约 **143 MiB**。这是该机器的离线基准，不是所有存储设备的性能保证。

真实 **Kimi K3 PM + DeepSeek Flash Worker** 与 **Codex 订阅 PM + DeepSeek API Worker** 分别通过持续追问、执行、独立验收、新进程查询、冷归档与备份恢复。补价验证只在隔离的真实会话副本里使用明确标记的测试价格，没有改用户价格配置，也不把测试价当厂商价；一笔取消后无法测量用量的真实请求继续保持不确定。

```text
cd E:\spawn-work\tui-ink
npm run build
node scripts/benchmark-audit.mjs 100000
node scripts/verify-round12.mjs --configured
node scripts/verify-round12.mjs --codex <账号支持的模型ID>
```

仍有边界：首次建立、索引失效或超配额后需要全量校验，来源元数据检查仍随分段数增长；索引不替代受保护原账本。未提供可信单价或没有实测用量的历史无法凭空算成确定费用，没有自动抓取并套用网上价格。厂商余额与发票仍需独立核对。Claude 继续暂不处理，Copilot 保持待登录验证。

## 第十三轮：索引迁移复用、后台重建与可信价格同步

### 索引失效后的处理

分段改名、活动文件封存或转为冷归档时，先验证旧边界、原始前缀或归档校验和；验证通过后保留已计算的模型/任务统计和明细，只处理新增事件。篡改、截断、历史分叉或不能证明同一前缀时仍完整校验，不拿“相同序号”代替内容验证。第十二轮索引可以从未变化来源的尾部补充校验锚点，无需为格式升级重新写入全部费用记录。

真正的全量重建复用预编译 SQL，批量插入后统一建立二级索引，减少重复查找；价格版本按端点与模型建立时间查找表。TUI 的 `/audit`、`/prices history` 和 agent 的 `BudgetStatus audit=true` 使用后台线程，检查点回放、SQLite 重建与缓存收缩不会占用 PM 主事件循环。同一工作区内的后台查询排队；跨进程锁争用只做有限重试，完整性错误不会被重试成部分成功。

本机离线 **10 万次请求、20 万条事件、200 个分段**：首次建索引约 **3.9 秒**，显式强制重建约 **6.2 秒**；分段封存后的校验复用约 **62 毫秒**；冷归档完成后的审计校验复用约 **0.8 秒**，**0 条费用事件重新统计**。归档生成本身约 9.6 秒，单独计时。这些是本机测试结果，不是不同磁盘上的性能保证。

### 自动价格与变更追溯

| 来源 | 自动应用范围与口径 |
| --- | --- |
| [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing/) | 精确官方端点及模型 ID；保留缓存命中、未命中、峰谷价格，预算使用保守的输入/输出估价 |
| [Kimi 国际定价](https://platform.kimi.ai/docs/pricing/chat)、[国内定价](https://platform.kimi.com/docs/pricing/chat) | 国际与国内端点分别匹配；保留缓存写入 TTL 与命中价格，国内原币 CNY 与国际 USD 不混用 |
| [OpenRouter 官方模型目录](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) | 只应用于 OpenRouter 官方端点及精确目录 ID；处理每 Token 单位转换与目录覆盖价格；标为目录估价，不能保证路由到不同提供商后的发票金额 |

国内 Kimi 的美元统计使用 [ECB 官方参考汇率](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) 换算，保留原币单价、汇率日期、来源和版本；参考换算不代表厂商结算汇率。缺失、过期或格式不合法的汇率不会被当成 1:1 美元价格。工具调用、税费和交易汇差不包含在 Token 估价中。

只读取固定的官方 HTTPS 地址，不向价格服务发送 API Key，不发起模型推理，也不执行页面中的脚本/MDX。代理、自定义路径、相似域名、订阅通道、无法识别的模型或计费结构不会被猜测套价。手工配置的单价继续优先；支持范围之外仍可使用 `/price` 和 `/billing`。

TUI 启动时预取，在后台检查到 **6 小时**刷新期后更新；受管理的 API 请求缺少手工单价时也会先检查同步，再使用有效本地报价。`SPAWN_PRICE_AUTO_SYNC=0` 关闭隐式网络同步，不影响显式 `/prices sync`。单次网络请求超时 10 秒；失败按 1 分钟起、最高 1 小时退避，手动刷新也遵守退避。有效报价最多保留 24 小时；到期且同步失败时退回明确的缺价状态，不能绕过美元预算的价格检查。源锁与账本锁独立，死亡进程或陈旧的不完整源锁可回收。

ETag/Last-Modified 用于条件请求，304 只能续期已验证的价格快照；新增模型没有快照时重新读取完整目录。解析失败、HTTP 拒绝、网络问题和汇率问题保留最后已验证数据及明确原因，不写入“零价格”。报价可用不表示账号已登录、余额充足或模型权限已开通。

价格观察写入受保护事件链：来源地址、页面摘要、解析器版本、规范化价格版本、前一版本、观察时间、有效区间及原币/换算依据均可追溯。每次请求保留实际采用的报价版本；新价格不追溯改写已经记账的消费、预留或防回滚底线。第一次观察到的当前价也不会被假定为几个月前的历史价。自动续期不伪装成厂商宣布的价格变更生效时间。

| 命令 | 功能 |
| --- | --- |
| `/prices` | 离线查看自动报价、来源、有效期与失败/退避原因 |
| `/prices sync` | 异步手动刷新固定官方来源，PM 可以继续沟通 |
| `/prices history` | 后台读取最近 100 条价格观察；完整版本见 `/audit --json` |
| `/account` | 同时展示模型配置、自动价格状态、预算与套餐状态 |
| `node scripts/session-prices.mjs [--sync] [--json]` | 命令行查询或同步；可用 `--root` 指定价格账本工作区 |

价格查询期间需求发生变化或任务超时，旧任务不会因此继续发起模型请求。本轮真实 Codex 验证还发现一次进度追问被回答成重复初始派单；持久记录确认输入未丢失。已将无状态订阅提示明确分为“已完成历史”和“当前输入”，重跑后正确回答进度问题；重复派单原有拒绝机制保持有效。提示结构不能保证模型永不出错，任务验收与预算约束仍然需要保留。

### 验证与边界

新增 **21 项专项测试**；全量 **799 项：792 通过、7 项原有 TODO、0 失败**。类型检查、构建、headless 82 项通过。标准单测关闭隐式价格网络请求，专用测试注入价格响应；真实验证单独开启官方网络与实际模型调用。

真实 **Kimi K3 PM + DeepSeek Flash Worker** 与 **Codex 订阅 PM + DeepSeek API Worker** 均完成任务、独立验收和执行期间的进度追问；同时进行后台审计重建。自动价格直接取自官方来源，未使用测试单价，也未修改用户模型配置。实际报价版本与消费在独立进程、冷归档和备份恢复后保持一致。另对当前用户配置完成了官方价格与国内汇率的只读联网同步验证。

```text
cd E:\spawn-work\tui-ink
npm run build
node scripts/benchmark-audit.mjs 100000
node scripts/verify-round13.mjs --configured
node scripts/verify-round13.mjs --codex <账号支持的模型ID>
```

仍有边界：索引真正损坏、被删或超配额时仍需要一次全量校验；迁移复用也需要读取并验证变化的归档。价格适配器依赖厂商公开格式，格式变化会拒绝更新并显示原因，需要维护适配器。当前自动价格覆盖上表端点，其他供应商与代理合同价仍需显式配置；当前目录不能补出首次观察前缺失的历史价格或未知用量。自动金额是估价，不是厂商余额或发票。Claude host 继续暂不处理，Copilot 仍待登录验证。
