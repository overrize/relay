import { randomUUID } from "node:crypto";
import { sessionJournal, type Projection, type Entry } from "./Journal.js";
import fs from "node:fs";
import path from "node:path";
import { writeSnapshot } from "../memory/atomic.js";
import { digest } from "./Storage.js";
import {priceEndpoint,priceFor} from "./Pricing.js";

export interface BillingSelection { provider?: string; model?: string; baseUrl?:string; transport?: string; billing?: { mode: "api" | "subscription"; inputUsdPerMillion?: number; outputUsdPerMillion?: number; priceSource?:string; priceRecordedAt?:number } }
type BillingUsage = { requests: number; tokens: number; microUsd: number };
export interface SessionBudget {
  unpricedApiRequests?: number;
  byBilling?: Record<"api" | "subscription", BillingUsage>;
  limits: { requests: number; tools: number; tokens: number; microUsd: number; communicationRequests: number; communicationTokens: number; communicationMicroUsd: number; inputRate: number; outputRate: number };
  used: { requests: number; tools: number; tokens: number; microUsd: number };
  reservations: Record<string, { agent: string; role: string; billingMode?: "api" | "subscription"; pricingKnown?: boolean; model?: string; provider?: string; input: number; output: number; tokens: number; microUsd: number; inputRate: number; outputRate: number; settled?: boolean; uncertain?: boolean }>;
}
function integer(name: string, fallback: number, minimum = 0) { const n = Number(process.env[name] ?? fallback); if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`${name} must be an integer >= ${minimum}`); return n; }
export function initialBudget(catalogPriced=false): SessionBudget {
  const requests = integer("SPAWN_SESSION_MAX_REQUESTS", 200, 1), tokens = integer("SPAWN_SESSION_MAX_TOKENS", 2000000, 1);
  const inputRate = Number(process.env.SPAWN_INPUT_USD_PER_MILLION ?? 0), outputRate = Number(process.env.SPAWN_OUTPUT_USD_PER_MILLION ?? 0), usd = Number(process.env.SPAWN_SESSION_MAX_USD ?? 0);
  if (![inputRate, outputRate, usd].every((n) => Number.isFinite(n) && n >= 0) || (usd > 0 && !catalogPriced && (!process.env.SPAWN_INPUT_USD_PER_MILLION || !process.env.SPAWN_OUTPUT_USD_PER_MILLION))) throw new Error("A USD cap requires explicit nonnegative input/output rates; prices are user estimates, not provider billing");
  return { limits: { requests, tools: integer("SPAWN_SESSION_MAX_TOOLS", 400, 1), tokens, microUsd: Math.round(usd * 1000000), inputRate, outputRate, communicationRequests: Math.min(Math.max(0, requests - 1), integer("SPAWN_COMMUNICATION_REQUESTS", 8)), communicationTokens: Math.min(Math.floor(tokens / 4), integer("SPAWN_COMMUNICATION_TOKENS", 64000)), communicationMicroUsd: Math.min(Math.floor(usd * 250000), (catalogPriced&&inputRate===0&&outputRate===0?Math.floor(usd*250000):Math.ceil(64000 * Math.max(inputRate, outputRate)))) }, used: { requests: 0, tools: 0, tokens: 0, microUsd: 0 }, reservations: {} };
}
function floorFile() { return path.join(process.cwd(), ".spawn", "budget-floor.json"); }
function persistFloor() { const b = sessionJournal().budget()!; const body = { version: 1, used: b.used, limits: b.limits, unpricedApiRequests: b.unpricedApiRequests ?? 0, ...(b.byBilling ? { byBilling: b.byBilling } : {}) }; writeSnapshot(floorFile(), JSON.stringify({ ...body, digest: digest(body) })); }
function ensure(agent: string,catalogPriced=false) {
  const j = sessionJournal(), b = j.binding(agent); if (!b) return undefined;
  if (!j.budget()) j.append("budget.created", b.conversation, agent, b.revision, initialBudget(catalogPriced));
  if (fs.existsSync(floorFile())) {
    const { digest: actual, ...floor } = JSON.parse(fs.readFileSync(floorFile(), "utf8"));
    if (floor.version !== 1 || digest(floor) !== actual) throw new Error("Budget floor is corrupt; inspect billing/restore history before continuing");
    const current = j.budget()!;
    if (Object.keys(floor.used).some((k) => floor.used[k] > (current.used as any)[k])) j.append("budget.floor", b.conversation, agent, b.revision, floor);
  }
  return { j, b, budget: j.budget()! };
}
export function reserveSessionRequest(agent: string, input: number, output: number, communication = false, selection: BillingSelection = {}) {
  const mode = selection.billing?.mode ?? "api",journal=sessionJournal();
  const quote=mode==="api"&&selection.billing?.inputUsdPerMillion===undefined&&selection.billing?.outputUsdPerMillion===undefined?priceFor({provider:selection.provider,model:selection.model,endpoint:priceEndpoint(selection.provider,selection.baseUrl),at:Date.now()} as any,journal.effectivePrices()):undefined;
  const scope = ensure(agent,!!quote); if (!scope) return undefined;
  const { j, b, budget } = scope, { limits: l, used: u } = budget;
  const inputRate = mode === "subscription" ? 0 : selection.billing?.inputUsdPerMillion ?? quote?.inputRate ?? l.inputRate;
  const outputRate = mode === "subscription" ? 0 : selection.billing?.outputUsdPerMillion ?? quote?.outputRate ?? l.outputRate;
  if (!["api","subscription"].includes(mode) || ![inputRate,outputRate].every((r) => Number.isFinite(r) && r >= 0)) throw new Error("Invalid model billing configuration");
  const pricingKnown = mode === "subscription" || !!quote || (selection.billing?.inputUsdPerMillion !== undefined && selection.billing?.outputUsdPerMillion !== undefined) || l.inputRate > 0 || l.outputRate > 0 || (!!process.env.SPAWN_INPUT_USD_PER_MILLION && !!process.env.SPAWN_OUTPUT_USD_PER_MILLION);
  const monetaryCap = mode === "api" && l.microUsd > 0;
  if (monetaryCap && !pricingKnown) throw new Error("SESSION_BUDGET_EXHAUSTED: API USD cap cannot be enforced without explicit prices");
  const canTalk = communication && !b.parent;
  const reqLimit = canTalk ? l.requests : l.requests - l.communicationRequests, tokenLimit = canTalk ? l.tokens : l.tokens - l.communicationTokens;
  let cap = Math.min(output, Math.max(0, tokenLimit - u.tokens - input));
  const costLimit = canTalk ? l.microUsd : l.microUsd - l.communicationMicroUsd;
  if (monetaryCap) cap = Math.min(cap, outputRate > 0 ? Math.floor((costLimit - u.microUsd - Math.ceil(input * inputRate)) / outputRate) : cap);
  if (u.requests >= reqLimit || cap < Math.min(256, output) || input + cap > tokenLimit - u.tokens) throw new Error("SESSION_BUDGET_EXHAUSTED: request/token/cost pool exhausted; use /budget to inspect or explicitly add allowance");
  const microUsd = Math.ceil(input * inputRate + cap * outputRate);
  if (monetaryCap && u.microUsd + microUsd > costLimit) throw new Error("SESSION_BUDGET_EXHAUSTED: configured cost estimate cap reached");
  const communicationOnly = u.requests >= l.requests - l.communicationRequests || u.tokens + input + cap > l.tokens - l.communicationTokens || !!(monetaryCap && u.microUsd + microUsd > l.microUsd - l.communicationMicroUsd);
  const id = randomUUID(), reservation = { priceQuote:quote, priceSource:selection.billing?.priceSource??quote?.source??(pricingKnown?"call-time-config":undefined),priceRecordedAt:selection.billing?.priceRecordedAt??quote?.recordedAt, endpoint:priceEndpoint(selection.provider,selection.baseUrl), agent, role: b.parent ? b.role : "PM", conversation:b.conversation, revision:b.revision, taskId:b.workId, transport:selection.transport??"http", communication:canTalk, input, output: cap, tokens: input + cap, microUsd, billingMode: mode, pricingKnown, model: selection.model?.slice(0,160), provider: selection.provider?.slice(0,80), inputRate, outputRate };
  j.append("budget.reserved", b.conversation, agent, b.revision, { id, reservation });
  persistFloor();
  return { id, maxOutput: cap, maxInput: input, communicationOnly };
}
export function settleSessionRequest(agent: string, id: string, input?: number, output?: number, stopReason?:string) {
  const scope = ensure(agent); if (!scope) return;
  const { j, b, budget } = scope, r = budget.reservations[id]; if (!r || r.settled) return;
  const measured = Number.isSafeInteger(input) && Number.isSafeInteger(output) && input! >= 0 && output! >= 0 && input! + output! > 0;
  // Missing usage, interrupted streams and failed requests keep their complete
  // reservation. A restart never refunds an operation with an unknown bill.
  j.append("budget.settled", b.conversation, agent, b.revision, { id, tokens: measured ? Math.ceil(input! + output!) : r.tokens, microUsd: measured ? Math.ceil(input! * r.inputRate + output! * r.outputRate) : r.microUsd, uncertain: !measured, ...(measured?{inputTokens:input,outputTokens:output}:{}),...(stopReason?{stopReason}:{}) });
  persistFloor();
}
export function consumeSessionTool(agent: string, name: string) {
  if (["SubscriptionUsage", "BudgetStatus", "TaskStatus", "TaskPolicy", "TaskRetry", "TaskReview", "TaskReconcile", "WorkspaceStatus"].includes(name)) return;
  const scope = ensure(agent); if (!scope) return;
  if (scope.budget.used.tools >= scope.budget.limits.tools) throw new Error("SESSION_BUDGET_EXHAUSTED: session tool allowance reached");
  scope.j.append("budget.tool", scope.b.conversation, agent, scope.b.revision, { name });
  persistFloor();
}
export function addSessionBudget(agent: string, increments: Partial<{ requests: number; tools: number; tokens: number; usd: number }>) {
  const scope = ensure(agent); if (!scope) throw new Error("Start a session before adjusting its budget");
  for (const [key, value] of Object.entries(increments)) if (!Number.isFinite(value) || value < 0 || (key !== "usd" && !Number.isSafeInteger(value))) throw new Error("Budget additions must be nonnegative numbers; counts must be integers");
  if (increments.usd && !scope.budget.limits.microUsd) throw new Error("No priced USD budget is configured; configure explicit rates before using a USD cap");
  scope.j.append("budget.added", scope.b.conversation, agent, scope.b.revision, increments); persistFloor(); return scope.j.budget();
}
export function budgetReport() { try { const j = sessionJournal(), root = j.bindings().find((b) => !b.parent); if (j.budget() && root) ensure(root.id); const b = j.budget(); return b ? { ...b, reservations: undefined, pendingOrUncertain: Object.values(b.reservations).filter((r) => !r.settled || r.uncertain).length, billingNote: "API microUsd is a configured estimate, not an invoice. Subscription tokens/requests are usage, not per-token USD; vendor quotas and optional extra usage charges remain external and unknown.", note: "Workspace-wide lifetime pool; prices are configured estimates. Unknown usage keeps the full reservation. /budget add explicitly extends limits without resetting spending." } : { note: "Budget initializes on the first managed request/tool" }; } catch (error) { return { error: String(error), note: "Accounting must be inspected before execution resumes" }; } }
export function reduceBudget(p: Projection, e: Entry) {
  if (e.kind === "budget.created") p.budget ??= e.data;
  const b = p.budget; if (!b) return;
  b.unpricedApiRequests ??= b.used.requests && !b.limits.inputRate && !b.limits.outputRate ? b.used.requests : 0;
  b.byBilling ??= { api: { requests: b.used.requests, tokens: b.used.tokens, microUsd: b.used.microUsd }, subscription: { requests: 0, tokens: 0, microUsd: 0 } };
  if (e.kind === "budget.reserved" && !b.reservations[e.data.id]) { const r = e.data.reservation; b.reservations[e.data.id] = r; if(r.billingMode !== "subscription" && r.pricingKnown !== true) b.unpricedApiRequests++; b.used.requests++; b.used.tokens += r.tokens; b.used.microUsd += r.microUsd; const usage = b.byBilling[r.billingMode === "subscription" ? "subscription" : "api"]; usage.requests++; usage.tokens += r.tokens; usage.microUsd += r.microUsd; }
  if (e.kind === "budget.settled") { const r = b.reservations[e.data.id]; if (r && !r.settled) { const usage = b.byBilling[r.billingMode === "subscription" ? "subscription" : "api"]; usage.tokens += e.data.tokens - r.tokens; usage.microUsd += e.data.microUsd - r.microUsd; b.used.tokens += e.data.tokens - r.tokens; b.used.microUsd += e.data.microUsd - r.microUsd; Object.assign(r, { tokens: e.data.tokens, microUsd: e.data.microUsd, settled: true, uncertain: e.data.uncertain }); } }
  if (e.kind === "budget.tool") b.used.tools++;
  if (e.kind === "budget.floor") { b.unpricedApiRequests = Math.max(b.unpricedApiRequests,e.data.unpricedApiRequests ?? 0); if (e.data.byBilling) for (const mode of ["api","subscription"] as const) for (const key of ["requests","tokens","microUsd"] as const) b.byBilling[mode][key] = Math.max(b.byBilling[mode][key],e.data.byBilling[mode][key]); for (const k of ["requests", "tools", "tokens", "microUsd"] as const) b.used[k] = Math.max(b.used[k], e.data.used[k]); for (const k of ["requests", "tools", "tokens", "microUsd"] as const) b.limits[k] = Math.max(b.limits[k], e.data.limits[k]); for (const r of Object.values(b.reservations)) if (!r.settled) { r.settled = true; r.uncertain = true; } }
  if (e.kind === "budget.added") for (const key of ["requests", "tools", "tokens"] as const) b.limits[key] += e.data[key] ?? 0;
  if (e.kind === "budget.added") b.limits.microUsd += Math.round((e.data.usd ?? 0) * 1000000);
  const settled = Object.keys(b.reservations).filter((id) => b.reservations[id]!.settled); for (const id of settled.slice(0, -200)) delete b.reservations[id];
}
