import type { Config, ProviderConfig, AgentConfigRole } from "../config.js";
import { getAgentProviderConfig, validateBillingConfig } from "../config.js";

export type ModelProfile = "pm" | "leader" | "implement" | "research" | "review" | "verify" | "secretary";
export interface ModelRouting {
  profiles?: Partial<Record<ModelProfile, string[]>>;
  /** Explicit opt-in. No implicit change from subscription to metered API. */
  allowApiFallback?: boolean;
}
export interface ModelCandidate { name: string; config: ProviderConfig }
export interface ModelRoute { profile: ModelProfile; candidates: ModelCandidate[]; skipped: Array<{ name: string; reason: string }> }

export function resolveModelRoute(cfg: Config, role: AgentConfigRole, profile: ModelProfile, override?: string): ModelRoute {
  const legacy = getAgentProviderConfig(cfg, role);
  // Explicit dispatch names resolve through the registry, never just replace a model ID
  // while accidentally retaining another provider's credentials or transport.
  if (override) {
    const ranked = cfg.routing?.profiles?.[profile];
    if (ranked?.length && !ranked.includes(override)) throw new Error("MODEL_ROUTE: dispatch override is not in the configured profile chain");
    const config = cfg.models[override] ?? { ...legacy, model: override };
    if(ranked?.length && cfg.models[ranked[0]!]?.billing?.mode === "subscription" && config.billing?.mode !== "subscription" && !cfg.routing?.allowApiFallback) throw new Error("MODEL_ROUTE: API fallback is disabled for this subscription profile");
    validateBillingConfig(config);
    return { profile, candidates: [{ name: override, config }], skipped: [] };
  }
  const names = cfg.routing?.profiles?.[profile];
  if (!names?.length) return { profile, candidates: [{ name: cfg.agents[role].model, config: legacy }], skipped: [] };
  if (names.length > 8 || new Set(names).size !== names.length) throw new Error("MODEL_ROUTE: use at most eight distinct registered models per profile");
  const route: ModelRoute = { profile, candidates: [], skipped: [] };
  let subscriptionSeen = false;
  for (const name of names) {
    const model = cfg.models[name];
    if (!model) { route.skipped.push({ name, reason: "not-registered" }); continue; }
    validateBillingConfig(model);
    const sub = model.billing?.mode === "subscription";
    subscriptionSeen ||= sub;
    if (!sub && subscriptionSeen && !cfg.routing?.allowApiFallback) { route.skipped.push({ name, reason: "api-fallback-disabled" }); continue; }
    if (model.transport !== "claude-cli" && model.transport !== "codex-cli" && model.transport !== "copilot-sdk" && model.transport !== "bedrock" && model.transport !== "vertex" && !model.apiKey && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(model.baseUrl ?? "")) { route.skipped.push({ name, reason: "missing-api-credential" }); continue; }
    route.candidates.push({ name, config: { ...model, ...(cfg.agents[role].maxTokens ? { maxTokens: cfg.agents[role].maxTokens } : {}) } });
  }
  if (!route.candidates.length) throw new Error("MODEL_ROUTE: no eligible configured model; inspect /route and provider login");
  return route;
}

/** Only availability failures can advance a ranked chain, never a budget fence,
 * malformed request, requirement cancellation or rejected tool execution. */
export function routeCanFallback(error: Error): boolean {
  return /SUBSCRIPTION_(?:AUTH|STOPPED|QUOTA)|\b(?:401|402|403|404|408|429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(error.message)
    && !/SESSION_BUDGET|SUBSCRIPTION_BUDGET|SUBSCRIPTION_PROTOCOL|MODEL_ROUTE|AbortError/i.test(error.message);
}
