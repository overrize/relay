# 供应商目录来源

`src/models/providerSnapshot.json` 是离线、版本固定的名称目录，来源为 MIT 许可的 `@code-yeongyu/senpi-ai@2026.10.19`（Mario Zechner 和贡献者、code-yeongyu/senpi 分支）。不包含 API Key、OAuth 令牌或可用于计费的价格。

- 包来源：https://www.npmjs.com/package/@code-yeongyu/senpi-ai/v/2026.10.19
- 注册表名单：https://github.com/code-yeongyu/oh-my-openagent/blob/657a02e/packages/omo-native/bin/lib/provider-map.json
- OmO 引擎声明：https://github.com/code-yeongyu/oh-my-openagent/blob/v5.1.38/packages/omo-native/package.json

模型数据文件逐个验证上游 `.manifest.json` 中的 SHA-256；没有数据分片的供应商从其模型种子模块读取，不编造不存在的目录。原注册表中 Ollama 为运行时发现，另加入其官方云端示例 `gemma4:31b`，仍标记为未验证预置。名称不代表当前可用性或账号权限，也不代表所有模型都支持 Relay 的调用协议。

2026-10-21 核对的官方兼容端点：

- Gemini：https://ai.google.dev/gemini-api/docs/openai
- Mistral：https://docs.mistral.ai/resources/migration-guides
- Ollama：https://docs.ollama.com/api/openai-compatibility
- xAI：https://docs.x.ai/developers/model-capabilities/legacy/chat-completions

重建需要先下载并解压固定版本的 `senpi` 和 `senpi-ai` 包（不执行安装脚本），并取得对应 OmO `provider-map.json`。然后运行：

```text
node scripts/import-omo-catalog.mjs <senpi-ai解压目录> <provider-map.json> <senpi的dist/core/provider-display-names.js>
```

生成过程不读取用户配置和凭据。版本变化应重新检查协议、地区端点、订阅与 API 的边界，再运行测试；不会在启动时自动执行下载代码。
