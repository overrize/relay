# 原生认证（第 20 轮）

在 `/login` 选择「账号登录 / OAuth / 云身份」，方向键选择供应商。

- **OpenRouter**：选择开始 OAuth，将界面给出的链接在本机浏览器打开。Relay 使用随机 loopback 回调路径、临时端口和 S256 PKCE；授权等待最长 5 分钟，Esc 取消。成功后选择模型和用途再确认保存，取消不会保存。官方返回的是用户可撤销的 API Key，沿用现有 API 密钥配置存储，**按账户 API 额度计费**，不是订阅。
- **Amazon Bedrock**：输入区域和可选 AWS profile。先在终端完成 `aws sso login --profile <profile>`，或配置环境、共享配置、工作负载身份。官方 SDK 默认凭据链负责 SSO、临时凭据和刷新；Relay 不保存 AWS 密钥。认证检查后用预置目录选择模型，实际请求使用 Bedrock Converse。区域、IAM、模型授权及 inference profile 是否有效，以实际调用结果为准。
- **Google Vertex**：输入 location 和 project ID。先运行 `gcloud auth application-default login`，或设置 `GOOGLE_APPLICATION_CREDENTIALS` 指向已有凭据文件；也支持官方库的工作负载身份和云环境 ADC。Relay 使用 `google-auth-library` 获取/刷新 access token，不持久化 token。目前仅提供 Gemini 的 OpenAI 兼容端点；非 Gemini 合作伙伴模型未接入。

云认证检查最多等待 30 秒，可取消；不会发起推理，也不表示模型权限已经通过。云区域和项目进入独立价格指纹，避免误匹配 OpenAI 端点价格。无价格时费用保持未知或使用明确的会话估价，不视为免费。请求仍经过统一预算、取消、需求版本检查与长期审计，历史费用快照不重写。

PM 在登录等待期间继续运行。AWS/GCP 的首次交互式登录目前由官方 CLI 在另一终端完成；本向导负责配置及凭据检查，未内嵌它们的首次浏览器登录。其他目录中的 OAuth 入口保持明确的未支持提示，不会静默降级成订阅认证。Claude 保持原样；Copilot 仍待账号登录验证。

## 验证

`npm test` 包含 `auth-round20.test.ts`：真实 loopback PKCE 回调、取消、SDK 签名的本地 HTTP/2 Bedrock 请求、普通 PM adapter 回复、Vertex 刷新与用量、脱敏错误、原生配置保存、中文/emoji 中间编辑。真实云端推理需要用户账号、计费和模型权限；本机未配置 AWS/GCP 账号时不能宣称已经验证。

输入光标改为终端细竖线（DECSCUSR 6），不再反色覆盖所在字符；重绘前恢复 Ink 的帧末位置，光标移动时独立刷新，退出恢复终端默认光标。终端不支持原生锚点时可设置 `SPAWN_INPUT_CURSOR_ANCHOR=0` 使用下划线回退。

来源：[OpenRouter OAuth](https://openrouter.ai/docs/guides/overview/auth/oauth)、[AWS 默认凭据链](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)、[Bedrock Runtime SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/)、[Google ADC](https://docs.cloud.google.com/docs/authentication)、[Vertex OpenAI 认证](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/auth-and-credentials)。核对于 2026-10-21。
