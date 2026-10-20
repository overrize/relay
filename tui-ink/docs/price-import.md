# 代理合同价与历史价目表批量导入

支持 JSON v1 和 UTF-8 CSV。所有行使用精确的协议供应商、模型 ID、代理地址和 `[effectiveFrom, effectiveTo)` 生效区间；相邻区间可以衔接，重叠区间拒绝整批导入。`effectiveTo: null`（CSV 空单元格）明确表示无固定终止。日期必须包含时间和时区。

## 工作流

在 E 盘保存价目表并核对来源机构、模型、代理地址、币种、单位和时间区间，然后在 TUI 使用：

```text
/prices trust "E:\contracts\price table.json" issuer=Agency
/prices import "E:\contracts\price table.json"
/prices import "E:\contracts\price table.json" --apply
/prices history
/account
/audit --json
```

`trust` 是用户对该文件的本地审核，固定整份文件的 SHA-256 和机构名，不是厂商数字签名认证。文件任意字节变化都需要重新审核。多个机构时使用排序后的机构名，以逗号连接，如 `issuer=AgencyA,AgencyB`。

默认 `import` 只校验和预览。`--apply` 在一个受保护的持久事件中提交整批数据；任何一行失败不会写入部分价格。可以加 `expect=预览返回的preview摘要`，将提交绑定到已预览的文件和价格版本。PM 对话不会令预览失效；期间价格或来源发生变化则拒绝提交，重新预览后再试。后台审计和价格校验期间 PM 可以继续通信。

CLI 等价操作（先 `npm run build`）：

```powershell
node scripts/import-prices.mjs trust "E:\contracts\price table.json" --root E:\spawn-work\tui-ink --issuer Agency
node scripts/import-prices.mjs import "E:\contracts\price table.json" --root E:\spawn-work\tui-ink
node scripts/import-prices.mjs import "E:\contracts\price table.json" --root E:\spawn-work\tui-ink --apply
```

## JSON 格式

以下是格式示例，单价和机构名仅供说明，必须替换为经过核对的实际合同内容：

```json
{
  "version": 1,
  "prices": [
    {
      "source": "contract-2026-A",
      "issuer": "Agency",
      "provider": "openai",
      "model": "exact-model-id",
      "baseUrl": "https://proxy.example/v1",
      "currency": "USD",
      "unit": "per-million-tokens",
      "inputRate": 1.25,
      "outputRate": 3.5,
      "effectiveFrom": "2026-01-01T00:00:00+08:00",
      "effectiveTo": "2027-01-01T00:00:00+08:00"
    }
  ]
}
```

`provider` 是接口协议类型，当前支持 `openai`、`anthropic`；不会根据代理的营销名称推断模型。地址不允许凭证、查询参数、fragment 或通配符；HTTPS 为默认要求，HTTP 仅限本机回环验证。文件不可包含 API Key。模型和路径的大小写必须精确；匹配端点时忽略末尾的 `/v1` 和斜线，与现有审计指纹一致。

来源 `source`、机构 `issuer` 使用 1–120 个字母、数字或 `-_.:/` 字符（`source` 还受到保存时 `contract:` 前缀后总长 120 的限制）。如有来源文件，可为每行补充 `document` 和 `documentSha256`：文档路径相对于价目表目录，真实路径必须在该目录内；文件摘要必须匹配。不会下载或执行来源文档。单份价目表最多 4 MiB、5000 行，来源文档最多 32 MiB。

CNY 价格必须额外填写 `usdPerUnit`、`fxSource`、`fxDate`（YYYY-MM-DD）。这是用户明确审核的历史/合同汇率；系统保留原始金额、币种和固定汇率，不会把今天的汇率用于历史补价。USD 不允许附带汇率字段。金额均按每百万 token 计，不包含税费、独立工具费用或结算汇差。

## CSV 格式

字段名与 JSON 每行相同，首行为字段名；支持 BOM、逗号、双引号和引号内换行。未知列、重复列、列数不一致会被拒绝。

```csv
source,issuer,provider,model,baseUrl,currency,unit,inputRate,outputRate,effectiveFrom,effectiveTo
contract-2026-A,Agency,openai,exact-model-id,https://proxy.example/v1,USD,per-million-tokens,1.25,3.5,2026-01-01T00:00:00Z,2027-01-01T00:00:00Z
```

## 优先级与账本

- 显式配置的模型单价优先。未配置单价的新请求依次使用有效合同价、精确官方端点的自动价格。代理地址不会套用官方地址的报价。
- 导入价与已有合同价、手工历史价在相同模型/端点上重叠时拒绝；合同价可以覆盖同一区间的自动官方报价。撤销和替换通过下述修订命令完成；不会隐式覆盖其他活动批次。
- 相同文件重复提交是无操作。整批来源、版本、文档摘要、生效时间和调用时价格快照保存在受保护历史里，随备份恢复，不依赖可丢弃的审计索引。
- 有实测用量但缺价的历史调用，在适用区间内显示独立的后补估算。原账本费用和已消费预算不变；缺少实测用量不编造费用。
- `PRICE_IMPORT_SOURCE_UNTRUSTED` 表示文件未审核或审核后有改动；`INTERVAL_CONFLICT` 表示时间重叠；`PREVIEW_STALE` 表示预览后价格版本改变；`CONCURRENT_CHANGE_RETRY` 表示校验期间有其他价格写入，应重新预览；`DOCUMENT_HASH` 表示来源文档变动。

## 验证

```powershell
npm run typecheck
npm test
npm run test:headless
npm run build
node scripts/verify-round14.mjs
```

最后一条需要现有真实 API 配置：在独立临时工作区启动真实 PM/Worker，Worker 通过本机转发代理访问原上游；导入明确标注的测试合同价格；验证持续 PM 对话、执行期间导入历史价、独立文件验收、费用快照、冲突拒绝、清理和备份恢复。测试价格不是实际厂商账单。不会更改用户模型配置，也不会探测 Claude；Copilot 仍待用户登录后验证。


## 撤销、替换与修订追溯

使用原导入结果的完整 64 位 `digest` 指定批次。`/prices history` 的 `importDigest`、`retired` 和 `revisions` 字段可追溯所有批次及修订。修订必须填写原因；默认只预览，`--apply` 才追加一个持久事件。

撤销（示例中的 `<批次摘要>` 必须替换为完整摘要）：

```text
/prices revoke <批次摘要> reason="核对后发现报价错误"
/prices revoke <批次摘要> reason="核对后发现报价错误" --apply
```

替换时先审核新文件，再预览和提交：

```text
/prices trust "E:\contracts\corrected.json" issuer=Agency
/prices replace <旧批次摘要> "E:\contracts\corrected.json" reason="修正输入单价和生效日期"
/prices replace <旧批次摘要> "E:\contracts\corrected.json" reason="修正输入单价和生效日期" --apply
```

两种修订均可加 `expect=预览摘要`。令牌绑定操作、目标批次、新文件摘要、原因和价格修订序号；普通 PM 对话不会使它失效。替换在同一个事件中停用旧批次并启用新批次，校验或写入前并发检查失败时两者都不改变。预览展示旧表、新表和影响行数；TUI 每表最多展示 20 行，CLI 返回完整内容。

CLI 等价命令：

```powershell
node scripts/import-prices.mjs revoke <DIGEST> --reason "报价不正确" --root E:\spawn-work\tui-ink
node scripts/import-prices.mjs revoke <DIGEST> --reason "报价不正确" --root E:\spawn-work\tui-ink --apply
node scripts/import-prices.mjs replace <DIGEST> "E:\contracts\corrected.json" --reason "核对合同后更正" --root E:\spawn-work\tui-ink --apply
```

规则和边界：

- 整批撤销/替换立即改变当前价目表选择。新文件中的合同生效区间仍按请求时间匹配；如果新表留有时间空档，该空档没有合同报价，预览时应核对。
- 替换必须保留相同的机构集合及协议供应商/模型/端点集合，可以修正单价、汇率和时间区间，也可以将原区间拆为多个不重叠区间。不能借替换悄悄丢掉模型或改为另一家代理。
- 新表仍必须通过文件审核、文档摘要和所有区间冲突检查。与目标批次以外的活动合同或手工历史价重叠会拒绝整批修订。
- 每次修订记录唯一 ID、事件序号、时间、原因、旧批次及后继批次。旧价格不删除；`retired` 说明其已撤销或被替换，新版本的 `replacesDigest` 指向前驱。
- 相同修订重复提交是无操作。已停用的文件不能通过普通 `import` 复活，也不能用旧摘要构造回滚环。确需恢复旧费率时，应准备并审核一个新的明确版本，而不是修改日志。
- **已经预留、已经结算或结果不确定的调用，保留原价格快照和预算金额。** 即便在 HTTP 请求执行期间修订，结算仍按预留时单价。后续请求重新选价；选择与预留之间遇到修订会在发出请求前有界重试。
- 缺价历史调用的后补估算会按当前有效的修订表重新计算，并保持“后补”标记；撤销后缺少有效报价则恢复为缺价。不会把后补差额写入原费用或已消费预算。
- 撤销后可回落到同一精确官方端点的有效官方报价，或原有显式手工单价；代理端点不会使用其他地址的官方价格。没有有效价格且启用了 USD 预算上限时，新调用明确停止，不把未知费用当免费。
- 目前操作粒度为完整导入批次，不支持只撤销其中一行、跨机构/端点的原子迁移或厂商数字签名认证；不会自动创建退款或账单调整记录。

新增错误码：`TARGET_DIGEST`（不是完整摘要）、`TARGET_NOT_FOUND`、`TARGET_RETIRED`、`RETIRED_BATCH`、`REVISION_REASON`、`REPLACEMENT_FILE`、`REPLACE_SAME_BATCH`、`REPLACEMENT_ALREADY_KNOWN`、`REPLACEMENT_SCOPE`。既有来源、区间冲突和预览失效错误码继续适用。

真实端到端验证：`npm run build` 后运行 `node scripts/verify-round15.mjs`。在独立工作区使用真实 Kimi PM 和 DeepSeek Worker；本机转发代理在第一条 Worker 请求尚未返回时等待 PM 真实进度回复并替换价格，在第二条请求进行中撤销更正表。校验两次调用分别保留原始/更正价格快照、任务通过独立验收、停用表不复活，以及清理和新进程备份恢复后的修订链与费用。测试费率明确是本地验证数据，不是厂商账单；不改动用户配置，不探测 Claude，Copilot 仍待登录验证。
