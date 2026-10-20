import type { Config, ProviderConfig } from "../config.js";
import { validateBillingConfig } from "../config.js";
import { resolveModelRoute, type ModelProfile } from "../models/routing.js";
import { budgetReport } from "../session/Budget.js";
import type { Binding } from "../session/Journal.js";
import { usageSources, type UsageSnapshot } from "../subscriptions/usage.js";

const when = (value?: number) => value ? new Date(value).toISOString() : "从未查询";
const amount = (value: number) => Math.max(0, value).toLocaleString("en-US");
export function usageReason(code?: string): string {
  const reasons: Record<string,string> = {
    "usage-forbidden":"查询被拒绝；可能与 host 或访问策略有关，未确认原因",
    "login-required":"需要官方客户端登录", "codex-login-required":"需要 ChatGPT 订阅登录",
    "copilot-login-required":"待 Copilot 登录验证", "login-or-scope-required":"访问被拒绝；登录或访问范围原因未确认",
    "rate-limited":"厂商限流，退避后可重试", "no-quota-data":"响应未提供可识别额度；余额未知",
    "query-in-progress":"另一查询正在进行", "invalid-usage-response":"响应格式无法识别",
    "codex-quota-rpc-failed":"官方 app-server 拒绝查询", "codex-quota-process-failed":"官方 app-server 未正常完成",
    "codex-quota-timeout":"官方 app-server 查询超时", "usage-http-error":"厂商 HTTP 查询失败",
  };
  return code ? reasons[code] ?? "查询不可用；未确认余额" : "尚无失败记录";
}
export function formatUsage(values: UsageSnapshot[], history = false): string {
  return values.map(v => {
    const state = {fresh:"新鲜",stale:"过期，仅供参考",unknown:"未知",error:"不可用"}[v.state];
    const lines = [`${v.provider} · ${state}`, `来源：${usageSources[v.provider]}`, `查询：${when(v.checkedAt)}；数据：${when(v.observedAt)}`];
    if (v.errorCode) lines.push(`原因：${usageReason(v.errorCode)} [${v.errorCode}${v.httpStatus ? ` / HTTP ${v.httpStatus}` : ""}]`);
    if (v.retryAt) lines.push(`允许重试：${when(v.retryAt)}（手动刷新同样遵守退避）`);
    lines.push(...v.windows.map(w => `${w.label}${w.scope?` (${w.scope})`:""}：${w.unlimited?"不限额":w.remainingPercent===undefined?"余额未知":`剩余 ${w.remainingPercent}%`}${w.remaining===undefined?"":` / ${w.remaining} ${w.unit??""}`}${w.resetsAt?`；重置 ${when(w.resetsAt)}`:""}`));
    if (!v.windows.length) lines.push("余额未知，不能作为零余额或登录成功的证据。");
    if (history) lines.push("最近查询（最多 10 次，缓存读取不算查询）：", ...(v.attempts??[]).map(a=>`${a.id} · ${when(a.at)} · ${a.state} · ${a.durationMs}ms${a.code?` · ${a.code}`:""}${a.httpStatus?` · HTTP ${a.httpStatus}`:""}`));
    return lines.join("\n");
  }).join("\n\n");
}
function endpoint(model: ProviderConfig) {
  if (model.transport && model.transport !== "http") return "官方订阅客户端；登录状态需独立验证";
  try { const url = new URL(model.baseUrl ?? (model.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com")); return `${url.protocol}//${url.host}`; }
  catch { return "端点无效"; }
}
export function formatModelConfig(cfg: Config): string {
  const models = Object.entries(cfg.models).map(([name,m])=>{
    let valid = true; try { validateBillingConfig(m); } catch { valid = false; }
    const sub = m.billing?.mode === "subscription", local = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(m.baseUrl??"");
    const pricing = sub ? "套餐消耗单独记账；本地不估算订阅账单" : m.billing?.inputUsdPerMillion!==undefined && m.billing.outputUsdPerMillion!==undefined ? `估价 $${m.billing.inputUsdPerMillion}/$${m.billing.outputUsdPerMillion} 每百万输入/输出 Token` : "模型未设价格；预算可能使用会话估价，不能视为免费";
    return `${name} → ${m.provider}/${m.model} · ${sub?"订阅":"API"} · ${m.transport??"http"}\n  ${endpoint(m)}；${valid?"配置结构有效":"配置无效"}${sub?"":`；凭据${m.apiKey?"已配置":local?"本地端点无需凭据":"缺失"}`}\n  ${pricing}；maxTokens=${m.maxTokens??"角色默认"}`;
  });
  const profiles: ModelProfile[] = ["pm","leader","implement","research","review","verify","secretary"];
  const routes = profiles.map(profile=>{
    const role=profile==="secretary"?"secretary":profile==="pm"||profile==="leader"?"leader":"worker";
    try {const r=resolveModelRoute(cfg,role,profile);return `${profile}: ${r.candidates.map(c=>c.name).join(" → ")}${r.skipped.length?`；跳过 ${r.skipped.map(s=>`${s.name} (${s.reason})`).join(", ")}`:""}`;}
    catch {return `${profile}: 无可用候选或配置无效；检查 /route、凭据与计费模式`;}
  });
  return `默认角色：${Object.entries(cfg.agents).map(([role,c])=>`${role}=${c.model}`).join("；")}\n已注册模型：\n${models.join("\n")}\n\n有效候选链（不代表已登录）：\n${routes.join("\n")}\n订阅后 API 降级：${cfg.routing?.allowApiFallback?"已显式允许":"关闭"}；修改对新启动/恢复的 agent 生效。\n/connect <名称> <claude-subscription|codex-subscription|copilot-subscription> <模型ID>\n/connect <名称> <preset|baseUrl> <模型ID> <apiKey>\n/billing <名称> api <输入美元/百万> <输出美元/百万>；/route <定位> <名称...>`;
}
export function formatBudget(report: ReturnType<typeof budgetReport>, bindings: Binding[] = []): string {
  if (!("used" in report) || !report.used || !report.limits) return "error" in report ? "预算读取失败；恢复执行前需检查账本。" : "预算尚未初始化；第一次受管理调用后建立。";
  const {used:u,limits:l}=report, left=(key:"requests"|"tokens"|"tools")=>amount(l[key]-u[key]);
  const lines=["工作区累计预算（含预留，不因重启清零）",`请求 ${amount(u.requests)}/${amount(l.requests)}，剩余 ${left("requests")}；Token ${amount(u.tokens)}/${amount(l.tokens)}，剩余 ${left("tokens")}；工具 ${amount(u.tools)}/${amount(l.tools)}，剩余 ${left("tools")}`,
    `执行池剩余：请求 ${amount(l.requests-l.communicationRequests-u.requests)}；Token ${amount(l.tokens-l.communicationTokens-u.tokens)}`,
    `PM 沟通预留：请求 ${amount(l.communicationRequests)}；Token ${amount(l.communicationTokens)}（包含在总额内，单次仍需满足输入/输出预算）`,
    `API 费用估算 $${(u.microUsd/1e6).toFixed(6)}；${l.microUsd?`上限 $${(l.microUsd/1e6).toFixed(6)}，剩余 $${(Math.max(0,l.microUsd-u.microUsd)/1e6).toFixed(6)}`:"未设置美元上限"}`,
    `未定价 API 请求 ${report.unpricedApiRequests??0}；未结算或消耗不确定 ${report.pendingOrUncertain}（近期请求缓存；完整记录见 /audit）`];
  for (const mode of ["api","subscription"] as const) {const b=report.byBilling?.[mode];if(b)lines.push(`${mode==="api"?"API":"订阅"}：${b.requests} 请求 / ${b.tokens} Token${mode==="api"?` / $${(b.microUsd/1e6).toFixed(6)} 估算`:"；厂商套餐余量另见 /usage"}`);}
  for (const b of bindings) {
    if(b.modelSelection) lines.push(`${b.id} 最近调用：${b.modelSelection.candidate??b.modelSelection.model} · ${b.modelSelection.transport} · ${b.modelSelection.billing} · ${when(b.modelSelection.at)}`);
    if(b.lastError) {const code=/\b(?:SUBSCRIPTION_[A-Z_]+|SESSION_BUDGET_EXHAUSTED|MODEL_ROUTE)\b/.exec(b.lastError)?.[0]??"agent-error";lines.push(`${b.id} 最近错误：${code}${code==="SUBSCRIPTION_BUDGET"?"；自动执行已暂停，明确继续不会重置已用预算":""}`);}
  }
  return lines.join("\n")+"\n金额是配置估价，不是厂商账单；未知消耗保留预留。/budget add 显式增加额度。";
}
