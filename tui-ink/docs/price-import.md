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
- 导入价与已有合同价、手工历史价在相同模型/端点上重叠时拒绝；合同价可以覆盖同一区间的自动官方报价。暂不支持撤销或替换已导入的重叠合同；修订应先准备无重叠的明确区间。
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
