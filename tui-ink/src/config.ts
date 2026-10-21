import type { ModelRouting } from "./models/routing.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeSnapshot } from "./memory/atomic.js";

function configDirectory() { return process.env.SPAWN_CONFIG_DIR ?? path.join(process.cwd(), ".spawn", "config"); }
export function configPath() { return path.join(configDirectory(), "config.json"); }

export type PaletteName = "paper" | "green" | "amber";

/** M2-1: which protocol rail a provider can drive. */
export interface ProviderCapabilities {
  nativeFC: boolean;          // supports native tool_use / tool_calls
  structuredOutput: boolean;  // supports structured / JSON-schema output
}

export interface BillingConfig {
  mode: "api" | "subscription";
  /** USD per million tokens; estimates, not an invoice. Subscription usage has no local per-token USD charge. */
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  priceSource?: string;
  priceRecordedAt?: number;
}
export interface ProviderConfig {
  transport?: "http" | "claude-cli" | "codex-cli" | "copilot-sdk";
  billing?: BillingConfig;
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  /** Explicit override; otherwise inferred by resolveCapabilities(). */
  capabilities?: ProviderCapabilities;
}

/**
 * Resolve a provider's protocol capabilities (M2-1). Explicit config wins.
 * Otherwise: Anthropic and first-party OpenAI drive the native rail; other
 * OpenAI-compatible endpoints (Kimi/DeepSeek/ollama/dashscope/…) default to the
 * text rail because native tool_use reliability varies — overridable per config.
 */
export function resolveCapabilities(
  cfg: Pick<ProviderConfig, "provider" | "baseUrl" | "capabilities">,
): ProviderCapabilities {
  if (cfg.capabilities) return cfg.capabilities;
  if (cfg.provider === "anthropic") return { nativeFC: true, structuredOutput: true };
  const base = cfg.baseUrl ?? "https://api.openai.com";
  const firstParty = /(^|\/\/)api\.openai\.com(\/|$)/.test(base);
  return { nativeFC: firstParty, structuredOutput: firstParty };
}

/** Which rail to run for a provider config: "native" (tool_use) or "text" (JSON protocol). */
export function selectRail(
  cfg: Pick<ProviderConfig, "provider" | "baseUrl" | "capabilities">,
): "native" | "text" {
  return resolveCapabilities(cfg).nativeFC ? "native" : "text";
}

export interface AgentRoleConfig {
  /** Model registry key. The actual provider/model/baseUrl/apiKey live in Config.models. */
  model: string;
  maxTokens?: number;
}

/**
 * Return the max_tokens budget for a given agent role and depth.
 * PM (leader, depth=0) is conservative; TL (depth=1) larger; worker largest.
 * Callers pass providerCfg.maxTokens first — this is the fallback when unset.
 */
export function resolveMaxTokens(role: string, depth?: number): number {
  if (role === "Secretary") return 1024;
  if (role === "Worker")    return 8192;
  if (role === "Leader") {
    if (depth === 0) return 2048; // PM: conservative budget
    if (depth === 1) return 4096; // TL: more room for planning
    return 8192;                  // deep leaders or unknown depth
  }
  return 8192; // unknown role: safe default
}

export type ProviderPreset = Omit<ProviderConfig, "model" | "apiKey"> & Partial<Pick<ProviderConfig, "model">>;

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  anthropic: { provider: "anthropic" },
  openai:    { provider: "openai", baseUrl: "https://api.openai.com" },
  deepseek:  { provider: "openai", baseUrl: "https://api.deepseek.com" },
  kimi:      { provider: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6" },
  "kimi-k3": { provider: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k3" },
  moonshot:  { provider: "openai", baseUrl: "https://api.moonshot.ai/v1" },
  "kimi-cn": { provider: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  ollama:    { provider: "openai", baseUrl: "http://localhost:11434" },
  dashscope: { provider: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
};

export type AgentConfigRole = "leader" | "secretary" | "worker";

export function isAgentConfigRole(role: string): role is AgentConfigRole {
  return role === "leader" || role === "secretary" || role === "worker";
}

export function resolveProviderConfigInput(
  preset: string,
  modelOrKey: string,
  maybeApiKey?: string,
): ProviderConfig | null {
  if (["copilot-subscription","codex-subscription","claude-subscription"].includes(preset) && maybeApiKey !== undefined) return null;
  if (preset === "copilot-subscription") return { provider: "openai", model: modelOrKey, apiKey: "", transport: "copilot-sdk", billing: {mode:"subscription"} };
  if (preset === "codex-subscription") return { provider: "openai", model: modelOrKey, apiKey: "", transport: "codex-cli", billing: { mode: "subscription" } };
  if (preset === "claude-subscription") return { provider: "anthropic", model: modelOrKey, apiKey: "", transport: "claude-cli", billing: { mode: "subscription" } };
  const base = PROVIDER_PRESETS[preset] ?? { provider: "openai" as const, baseUrl: preset };
  const model = maybeApiKey ? modelOrKey : base.model;
  const apiKey = maybeApiKey ?? modelOrKey;
  if (!model || !apiKey) return null;
  return { ...base, model, apiKey };
}

export function resolveModelConfigInput(
  presetOrBaseUrl: string,
  modelOrKey: string,
  maybeApiKey?: string,
): ProviderConfig | null {
  return resolveProviderConfigInput(presetOrBaseUrl, modelOrKey, maybeApiKey);
}

export interface ServerConfig {
  port: number;
  enabled: boolean;
}

export type WebSearchProviderType = "brave" | "serper";

export interface WebSearchProviderConfig {
  type: WebSearchProviderType;
  apiKey: string;
  baseUrl?: string;
  hl?: string;
  gl?: string;
}

export interface WebConfig {
  search: {
    enabled: boolean;
    provider: string;
    maxResults?: number;
    timeoutSeconds?: number;
  };
  providers: Record<string, WebSearchProviderConfig>;
}

export interface Config {
  routing?: ModelRouting;
  palette: PaletteName;
  layout: "v1" | "v3";
  models: Record<string, ProviderConfig>;
  agents: Record<AgentConfigRole, AgentRoleConfig>;
  web: WebConfig;
  server?: Partial<ServerConfig>;
}

const DEFAULT_PROVIDER: ProviderConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  apiKey: "",
};

const DEFAULT: Config = {
  palette: "paper",
  layout: "v1",
  models: {
    "claude-sonnet-4-5": { ...DEFAULT_PROVIDER },
    "deepseek-chat": { provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", apiKey: "" },
    "deepseek-reasoner": { provider: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-reasoner", apiKey: "" },
    "kimi-k2.6": { provider: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", apiKey: "" },
  },
  agents: {
    leader:    { model: "claude-sonnet-4-5" },
    secretary: { model: "claude-sonnet-4-5" },
    worker:    { model: "claude-sonnet-4-5" },
  },
  web: {
    search: {
      enabled: true,
      provider: "serper",
      maxResults: 5,
      timeoutSeconds: 10,
    },
    providers: {},
  },
};

function isProviderConfig(value: unknown): value is ProviderConfig {
  const v = value as Partial<ProviderConfig> | null;
  return !!v && typeof v === "object" &&
    (v.provider === "anthropic" || v.provider === "openai") &&
    typeof v.model === "string" &&
    typeof v.apiKey === "string";
}

function normalizeConfig(parsed: Partial<Config> & { agents?: Record<string, unknown>; models?: Record<string, ProviderConfig> }): Config {
  const models: Record<string, ProviderConfig> = {
    ...DEFAULT.models,
    ...(parsed.models ?? {}),
  };
  const agents: Record<AgentConfigRole, AgentRoleConfig> = {
    leader: { ...DEFAULT.agents.leader },
    secretary: { ...DEFAULT.agents.secretary },
    worker: { ...DEFAULT.agents.worker },
  };

  const web: WebConfig = {
    search: {
      ...DEFAULT.web.search,
      ...(parsed.web?.search ?? {}),
    },
    providers: {
      ...(parsed.web?.providers ?? {}),
    },
  };

  for (const role of ["leader", "secretary", "worker"] as AgentConfigRole[]) {
    const raw = parsed.agents?.[role];
    if (isProviderConfig(raw)) {
      models[raw.model] = raw;
      agents[role] = { model: raw.model, ...(raw.maxTokens ? { maxTokens: raw.maxTokens } : {}) };
    } else if (raw && typeof raw === "object" && typeof (raw as Partial<AgentRoleConfig>).model === "string") {
      const roleCfg = raw as Partial<AgentRoleConfig>;
      agents[role] = {
        model: roleCfg.model!,
        ...(typeof roleCfg.maxTokens === "number" ? { maxTokens: roleCfg.maxTokens } : {}),
      };
    } else if (typeof raw === "string") {
      agents[role] = { model: raw };
    }
  }

  return {
    ...DEFAULT,
    ...parsed,
    models,
    agents,
    web,
  };
}

const sessionModels = new Map<string, Partial<Record<AgentConfigRole, string>>>();
export function loadSavedConfig(): Config { return readConfig(); }
/** Process-local overrides; credential/config writes always read persisted data. */
export function selectSessionModel(role: AgentConfigRole, name: string): boolean {
  if (!readConfig().models[name]) return false;
  sessionModels.set(configPath(), {...sessionModels.get(configPath()), [role]: name});
  return true;
}
export function loadConfig(): Config {
  const cfg = readConfig();
  for (const [role, name] of Object.entries(sessionModels.get(configPath()) ?? {}) as [AgentConfigRole,string][]) {
    if (!cfg.models[name]) continue;
    cfg.agents[role] = {...cfg.agents[role], model:name};
    const profile = role === "leader" ? "pm" : role === "worker" ? "implement" : "secretary";
    cfg.routing = {...cfg.routing, profiles:{...cfg.routing?.profiles,[profile]:[name]}};
  }
  return cfg;
}
function readConfig(): Config {
  try {
    const local=configPath(),legacy=path.join(os.homedir(),".config","multi-agent-tui","config.json");
    const raw = fs.readFileSync(!process.env.SPAWN_CONFIG_DIR&&!fs.existsSync(local)?legacy:local, "utf8");
    const parsed = JSON.parse(raw) as Partial<Config> & { agents?: Record<string, unknown> };
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig({});
  }
}

export function getAgentProviderConfig(cfg: Config, role: AgentConfigRole): ProviderConfig {
  const roleCfg = cfg.agents[role];
  const modelCfg = cfg.models[roleCfg.model] ?? cfg.models[DEFAULT.agents[role].model] ?? DEFAULT_PROVIDER;
  return {
    ...modelCfg,
    ...(roleCfg.maxTokens ? { maxTokens: roleCfg.maxTokens } : {}),
  };
}

export function savePalette(name: PaletteName): void {
  try {
    fs.mkdirSync(configDirectory(), { recursive: true });
    const existing = readConfig();
    fs.writeFileSync(configPath(), JSON.stringify({ ...existing, palette: name }, null, 2));
  } catch { /* 静默失败，不影响 UI */ }
}

export function saveLayout(l: "v1" | "v3"): void {
  try {
    fs.mkdirSync(configDirectory(), { recursive: true });
    const existing = readConfig();
    fs.writeFileSync(configPath(), JSON.stringify({ ...existing, layout: l }, null, 2));
  } catch { /* 静默失败 */ }
}

export function saveAgentConfig(role: AgentConfigRole, cfg: ProviderConfig): void {
  try {
    fs.mkdirSync(configDirectory(), { recursive: true });
    const existing = readConfig();
    existing.models[cfg.model] = cfg;
    existing.agents[role] = { model: cfg.model, ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}) };
    fs.writeFileSync(configPath(), JSON.stringify(existing, null, 2));
  } catch { /* 静默失败 */ }
}

export function saveModelConfig(name: string, cfg: ProviderConfig): void {
  if (!name.trim() || ["__proto__","prototype","constructor"].includes(name)) throw new Error("Invalid model registry name");
  if (!cfg.model.trim()) throw new Error("Model ID is required");
  validateBillingConfig(cfg);
  fs.mkdirSync(configDirectory(), { recursive: true });
  const existing = readConfig();
  existing.models[name] = cfg;
  fs.writeFileSync(configPath(), JSON.stringify(existing, null, 2));
}

export function saveAgentModel(role: AgentConfigRole, modelName: string): boolean {
  try {
    const existing = readConfig();
    if (!existing.models[modelName]) return false;
    fs.mkdirSync(configDirectory(), { recursive: true });
    existing.agents[role] = { ...existing.agents[role], model: modelName };
    const profile=role==="leader"?"pm":role==="worker"?"implement":"secretary";
    existing.routing={...existing.routing,profiles:{...existing.routing?.profiles,[profile]:[modelName]}};
    writeSnapshot(configPath(), JSON.stringify(existing, null, 2));
    const overrides = sessionModels.get(configPath());
    if (overrides) delete overrides[role];
    return true;
  } catch {
    return false;
  }
}

export function saveWebSearchProvider(name: string, cfg: WebSearchProviderConfig): void {
  try {
    fs.mkdirSync(configDirectory(), { recursive: true });
    const existing = readConfig();
    existing.web.providers[name] = cfg;
    existing.web.search.provider = name;
    existing.web.search.enabled = true;
    fs.writeFileSync(configPath(), JSON.stringify(existing, null, 2));
  } catch { /* 静默失败 */ }
}

export function saveWebSearchSelection(providerName: string): boolean {
  try {
    const existing = readConfig();
    if (!existing.web.providers[providerName]) return false;
    fs.mkdirSync(configDirectory(), { recursive: true });
    existing.web.search.provider = providerName;
    existing.web.search.enabled = true;
    fs.writeFileSync(configPath(), JSON.stringify(existing, null, 2));
    return true;
  } catch {
    return false;
  }
}


export function validateBillingConfig(config: ProviderConfig): void {
  const pricing=config.billing;
  if(pricing?.priceSource!==undefined&&(!/^[-\p{L}\p{N}_.:/]{1,120}$/u.test(pricing.priceSource)))throw new Error("Price source must be a short source label, without credentials or query strings");
  if(pricing?.priceRecordedAt!==undefined&&(!Number.isFinite(pricing.priceRecordedAt)||pricing.priceRecordedAt<0))throw new Error("Invalid price recording date");
  const b = config.billing;
  if (b && !["api", "subscription"].includes(b.mode)) throw new Error("Billing mode must be api or subscription");
  for (const rate of [b?.inputUsdPerMillion,b?.outputUsdPerMillion]) if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) throw new Error("Prices must be finite nonnegative USD per million tokens");
  if (config.transport && !["http","claude-cli","codex-cli","copilot-sdk"].includes(config.transport)) throw new Error("Unknown model transport");
  if (config.transport === "copilot-sdk" && (b?.mode !== "subscription" || config.apiKey || config.baseUrl)) throw new Error("copilot-sdk requires subscription mode without API key/baseUrl");
  if (config.transport === "codex-cli" && (config.provider !== "openai" || b?.mode !== "subscription" || config.apiKey || config.baseUrl)) throw new Error("codex-cli requires ChatGPT subscription mode without API key/baseUrl");
  if (config.transport === "claude-cli" && (config.provider !== "anthropic" || b?.mode !== "subscription" || config.apiKey || config.baseUrl)) throw new Error("claude-cli requires Claude subscription mode without API key/baseUrl");
}

export function saveModelRouting(routing: ModelRouting): void {
  const existing = readConfig(); fs.mkdirSync(configDirectory(),{recursive:true});
  fs.writeFileSync(configPath(),JSON.stringify({...existing,routing},null,2));
}

/** One atomic configuration transaction for the human-only login wizard. */
export function saveLoginModel(name:string,model:ProviderConfig,target:"register"|"worker"|"pm"|"all") {
  if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(name)||["__proto__","constructor","prototype"].includes(name))throw new Error("Invalid registry name");
  if(!model.model.trim())throw new Error("Model ID required");validateBillingConfig(model);
  const cfg=readConfig();cfg.models[name]=model;
  const roles:AgentConfigRole[]=target==="all"?["leader","worker","secretary"]:target==="worker"?["worker"]:target==="pm"?["leader"]:[];
  for(const role of roles)cfg.agents[role]={...cfg.agents[role],model:name};
  const profiles=target==="all"?["pm","leader","implement","research","review","verify","secretary"]:target==="worker"?["implement"]:target==="pm"?["pm"]:[];
  cfg.routing={...cfg.routing,profiles:{...cfg.routing?.profiles}};
  for(const profile of profiles)(cfg.routing.profiles as Record<string,string[]>)[profile]=[name];
  writeSnapshot(configPath(),JSON.stringify(cfg,null,2));
  const overrides=sessionModels.get(configPath());
  if(overrides)for(const role of roles)delete overrides[role];
}
