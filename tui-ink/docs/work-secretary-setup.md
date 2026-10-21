# 工作秘书：Relay、OmO Native 与飞书日报／周报

状态：已实现第一版。Relay 扩展现有 SecretaryProxy；OmO Native 扩展采集工作事件，独立 SecretaryAgent 进程整理日报、周报。客户端不等待模型整理或飞书网络请求。

## 需要管理员提供的配置

| 配置 | 用途与约束 |
| --- | --- |
| 企业自建应用 App ID、App Secret | Secret 只进发布服务的环境变量，不能放员工客户端配置、仓库、聊天或主 agent 的项目文件 |
| tenant_key | 真正的飞书租户 key；每次新认证后调用企业信息接口核对，不接受用公司名称代替 |
| 员工内部 ID + 本应用下的飞书 open_id | 内部 ID 用于记录归属；open_id 用于授予员工文档编辑、审计文档阅读权限 |
| leader 的 open_id 列表 | 仅授予指定员工报告及审计的阅读权限，不自动推断组织架构 |
| 每名员工独立的工作文档 folder token | 禁止两名员工复用报告文件夹；应由应用创建或由管理员确认是专用、受限目录 |
| 独立的审计 folder token | 不与员工工作文件夹相同；普通员工不能编辑整个审计目录 |
| 可选 serviceGroupId | 仅当应用通过专用机器人群获得文件夹访问权时填写。该群只能含发布服务管理员与应用机器人；客户端会核对群 ID，但不会枚举或证明其成员构成，管理员必须维护这一边界 |
| 工作根目录、project ID、排除目录 | 配置在工作区之外。真实路径校验，过滤外部目录、符号链接逃逸、`.spawn`、`.git`、`node_modules` 和显式排除目录 |
| 每名员工独立上传令牌 | 至少 32 字符；服务器绑定 employee、tenant、允许的 project；不能全员共享一个令牌 |
| 服务地址、时区、dailyAt、weeklyDay | 示例为本机 `127.0.0.1:43190`、香港时区、18:00 日报、周一 18:00 发布上一完整周的周报。跨设备需要 HTTPS 反向代理，不能把无 TLS 的采集端口直接暴露到公网 |
| 可选独立秘书模型 | OpenAI 兼容 HTTPS API 前缀、模型名、Key 的环境变量名、每日请求预算与输出 token 上限。默认无模型调用；事实由证据模板整理，模型只给已知证据排序 |

每个客户端只有它自己的上传令牌，不持有 App Secret。跨设备由可信服务器接收经过范围过滤的结构化事件；同机也可以让客户端与发布进程共用同一个 SQLite store 路径。

## 飞书应用权限和目录

按以下已使用接口在飞书 API Explorer 开通相应的**应用身份**权限；以当前平台显示的细分权限为准：

- 获取企业信息：`GET /tenant/v2/tenant/query`。
- 创建、读取 Docx，列出块、创建块：`/docx/v1/documents` 及其 blocks/children 接口。
- 列出目标文件夹、创建专用文件夹：`/drive/v1/files`、`/drive/v1/files/create_folder`。
- 读取协作者、增加/更新协作者：`/drive/v1/permissions/:token/members`。
- 更新云文档公共权限：`PATCH /drive/v2/permissions/:token/public`。

本功能不读取通讯录全集、聊天记录，不调用消息发送接口，也不需要消息回调 URL。应用的可用范围必须包括被授权员工；仅有接口权限而没有目标目录的数据权限会收到 403。

每次发布前核对文件夹协作者，拒绝未声明的成员。员工报告可编辑，leader 只读；审计文档员工与 leader 只读；文档关闭公开链接、外部访问，协作者管理保留给 full_access。继承权限与专用机器人群的实际成员仍需管理员确认，不将权限列表检查误称为完整组织安全审计。

认证使用[新的自建应用 OAuth 凭据接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)，缓存令牌并按服务端 expires_in 更新；不把密钥或服务端错误正文打印进日志。Docx/Drive 请求契约同时对照官方 `@larksuiteoapi/node-sdk@1.76.0` 类型定义验证。

## E 盘首次配置

本机已准备以下模板，真实配置不会提交 Git：

```text
E:\RelaySecretary\client.example.json
E:\RelaySecretary\client.env.example
E:\RelaySecretary\publisher.example.json
E:\RelaySecretary\publisher.env.example
```

复制成 `client.json`、`client.env`、`publisher.json`、`publisher.env` 后填入实际值。先保持 `client.json` 的 enabled=false，核对工作区与排除目录，再开启。两端客户端使用同一份 client.json，可共享暂停状态与持久上传队列。

`publisher.json` 的 model 可选示例：

```json
"model": {
  "baseUrl": "https://YOUR_PROVIDER/v1",
  "name": "YOUR_MODEL",
  "keyEnv": "RELAY_SECRETARY_MODEL_KEY",
  "requestsPerDay": 3,
  "maxOutputTokens": 1024
}
```

发布进程环境文件：

```dotenv
RELAY_FEISHU_APP_SECRET=YOUR_APP_SECRET
RELAY_SECRETARY_EMPLOYEE_TOKEN=YOUR_RANDOM_32_PLUS_CHARACTER_TOKEN
RELAY_SECRETARY_MODEL_KEY=OPTIONAL_MODEL_KEY
```

客户端环境文件只放其上传令牌。不要把 publisher.env 复制给员工。多个员工在发布配置 ingest.clients 中分别配置独立 tokenEnv 与项目范围。

从 `E:\spawn-work\tui-ink` 构建并检查：

```powershell
npm run build
node --use-env-proxy --env-file=E:\RelaySecretary\publisher.env dist/worklog/cli.js doctor --publish E:\RelaySecretary\publisher.json
```

需要通过应用建立专用目录时：

```powershell
node --use-env-proxy --env-file=E:\RelaySecretary\publisher.env dist/worklog/cli.js provision --publish E:\RelaySecretary\publisher.json --name "员工1工作报告"
```

将返回的 folder token 填回对应员工配置；另外创建私有审计目录。平台若不允许当前身份在根目录创建文件夹，先由管理员提供一个应用可访问的专用目录，不能改成公开共享来绕过 403。

发布服务启动入口：`E:\RelaySecretary\start-publisher.cmd`。它独立于客户端运行，客户端退出后仍可按时生成/上传；服务停止期间的事件、待生成日期与上传状态持久保存，重启会续做。部署机器须保持运行，可由管理员交给系统服务或任务计划程序管理；本轮没有擅自注册系统级常驻任务。

员工客户端入口（从工作目录运行）：

```powershell
E:\RelaySecretary\relay-secretary.cmd
E:\RelaySecretary\omo-secretary.cmd
```

也可直接用环境变量 `RELAY_WORKLOG_CONFIG` 加载，并给 OmO 传 `--extension E:/spawn-work/tui-ink/integrations/omo/work-secretary.mjs`。不需要把扩展安装到 C 盘。

## 交互与生成规则

Relay：`/worklog status|pause|resume|sync`。状态命令不会启动模型；sync 只通知后台采集/上传，不在输入处理中等待网络。

OmO：相同的 status、pause、resume；`/worklog task <共享任务ID> <工作标题>` 显式登记工作事项。将 ID 填成 Relay 任务 ID 且使用同一 project，可以合并两端证据。没有明确关联时使用客户端自己的工作 ID。跨端状态冲突标为待核对，不推断完成。

- 普通消息、提示词、工具命令、工具输出不进入工作记录。在登记工作目录内进行私人问答时，也应先用 pause 暂停。Relay 对隐式初始问答目标仅记录版本变更，不复制问答正文；工作指令和已派任务采用脱敏标题。
- OmO 只读取选定工具元数据、登记事项和自身的工作 custom entry；不读取用户消息正文。custom entry 支持重启补录，事件 ID 去重。
- 工具返回或会话停稳不等于验收。OmO 的会话停稳记录不会单独生成工作成果；Relay 只有 task accepted 记录才进入已验证。
- 暂停时不采集新记录；持久暂停区间保证重启后不会把暂停期间的事件补传。两个客户端在同一 store 中共享状态，跨设备需分别暂停相应客户端。
- 日报/周报包含规则版本、生成器代码摘要、提示规则摘要、模型请求 ID、可用的 token 用量、源事件 ID/摘要和生成依据摘要；费用未定价时保留 unknown；私有审计文档追加原始生成快照和脱敏的结构化源证据。模型输出只允许排列现有 ID，不能添事实或改验收状态。模型失败或预算用尽时采用证据模板，保留原因。
- 新事件进入持久待生成日期队列，超过七天的迟到事件也会补报。每轮最多生成 20 个期间、发布 10 个任务，积压可追溯，不无限循环。

## 员工编辑与修订

员工直接编辑飞书日报/周报。新机器版本追加，永不整篇覆盖。服务轮询发现变化时记录前后摘要、文档版本、段落差异和修订依据；旧生成快照不被改写。周报合并相同工作项，并列出员工对日报的更正。

API 不能证明两次同步之间的每次按键或每次编辑者身份，因此记录为 `unknown-feishu-editor`，不会伪造具体员工签名。审计文档只读给员工/leader；若需要精确到每次操作与人员的合规审计，需接入租户实际支持的审计能力。此版本不是反作弊、工时或绩效监控系统。

## 故障、追溯和恢复

```powershell
node dist/worklog/cli.js status --config E:\RelaySecretary\client.json
node dist/worklog/cli.js jobs --publish E:\RelaySecretary\publisher.json
node dist/worklog/cli.js verify --publish E:\RelaySecretary\publisher.json
node --use-env-proxy --env-file=E:\RelaySecretary\publisher.env dist/worklog/cli.js sync --publish E:\RelaySecretary\publisher.json
```

源事件和采集游标在同一事务提交，源 ID 重放去重；报告生成和上传队列在同一事务提交。账本使用 SQLite FULL 同步，审计记录有摘要链，不能把它当作能抵御同权限管理员改写的外部不可变存储。

发布自动重试最多 6 次，客户端上传最多 10 次；失败代码、尝试次数与下一次时间保留。修复配置后可显式 `retry --job <id> --reason <说明>`。创建结果不确定时，先按稳定文档标识对账，找不到不会盲目再建。人工确认后使用 `reconcile --report <id> --reason <说明> --document <token>`；确认根本没有创建才使用 `--confirm-absent`，审计文档加 `--audit`。所有人工续试留痕。

强杀后租约可识别本机已退出的拥有者；非本机或仍存活的拥有者等待租约过期，不随意抢占。客户端观察历史使用无写锁的只读模式，不会因为秘书读账本而使 PM 写入抛锁冲突；读取遇到轮转或来源变化时后台重试。

## 验证入口与真实飞书边界

```powershell
npm test
npm run test:headless
npm run test:live:native
npm run test:live:secretary
node --use-env-proxy --env-file=E:\RelaySecretary\publisher.env scripts/verify-secretary-feishu.mjs E:\RelaySecretary\publisher.json
```

单元/进程测试覆盖工作区、符号链接、暂停后补录过滤、原子游标、跨员工/项目拒绝、跨端归并、规则与模型预算、飞书 HTTP 分页/权限、创建与追加结果不确定、真实 SIGKILL 后续传、不覆盖员工修改、日报更正进入周报及迟到补报。

`test:live:secretary` 会使用现有配置的 Worker 兼容 API 做一次真实秘书模型请求，但飞书请求发往本地 HTTP 契约服务器，明确不是企业租户联调。

最后一条脚本才访问真实飞书。它使用独立 verification 员工命名空间，在已配置目录创建带测试标识的日报、周报和审计文档，不会替换正式报告。员工还需实际打开日报、修改并运行 sync，才能验证员工账号的完整编辑体验。凭据/租户/目录未提供时，不把契约测试称为真实飞书验证。

## 本轮实测记录（2026-10-21）

- OmO Native 5.1.38 实际加载扩展，执行工作登记、暂停、恢复，并完成真实模型对话；账本只包含工作登记及停稳元数据，私人问题标记未入账。
- Relay 新 TUI 接真实 kimi-k3 PM：执行中追问、需求变更取消旧 Worker、强杀重启恢复均通过；秘书捕获新目标，普通追问正文未进入工作账本。
- 独立秘书使用 deepseek-flash 完成一次真实模型请求，随后经本地 HTTP 飞书契约服务器验证双端归并、日报、员工更正、周报、审计与重试恢复。该服务器不代表真实飞书租户。
- 真实飞书验证脚本与 E 盘配置模板已准备；真实应用凭据由管理员稍后填入。租户授权、实际继承权限与员工账号编辑体验仍待真实联调。
