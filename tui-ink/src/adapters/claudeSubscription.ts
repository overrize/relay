import { subscriptionStopReason } from "./subscriptionErrors.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execCommand, withToolCancellation, cancelAgentTools } from "../tools/command.js";
import { validateBillingConfig, type ProviderConfig } from "../config.js";

/** Do not inherit API credentials, endpoints, cloud providers, or helper commands.
 * OAuth remains owned by the official CLI; spawn never reads its token files. */
export function subscriptionEnvironment(source: NodeJS.ProcessEnv, maxOutput: number): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_|CLAUDECODE$|NODE_TEST_CONTEXT$)/i.test(key)) delete env[key];
  // Preserve only an explicitly selected official login directory.
  if (source.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = source.CLAUDE_CONFIG_DIR;
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutput);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

export function parseSubscriptionResult(raw: string) {
  let result: any;
  try { result = JSON.parse(raw); } catch { throw new Error("SUBSCRIPTION_PROTOCOL: CLI returned invalid JSON; usage is uncertain"); }
  if (result.is_error || result.type !== "result" || result.subtype !== "success" || typeof result.result !== "string") throw new Error(`SUBSCRIPTION_STOPPED: ${subscriptionStopReason(JSON.stringify(result))}; inspect the official Claude CLI`);
  if (result.num_turns !== 1) throw new Error("SUBSCRIPTION_PROTOCOL: expected one bounded model turn");
  const usage = result.usage;
  // Missing/invalid usage is deliberately undefined so the budget keeps its reservation.
  const counts = [usage?.input_tokens, usage?.output_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0];
  const valid = counts.every((n) => Number.isSafeInteger(n) && n >= 0);
  return { text: result.result, promptTokens: valid ? counts[0] + counts[2] + counts[3] : undefined, completionTokens: valid ? counts[1] : undefined };
}

export async function callClaudeSubscription(config: ProviderConfig, system: string, messages: Array<{ role: string; content: string }>, options: { agent: string; maxOutput: number; signal?: AbortSignal; run?: typeof execCommand }) {
  validateBillingConfig(config);
  if (config.transport !== "claude-cli") throw new Error("SUBSCRIPTION_CONFIG: expected claude-cli transport");
  const run = options.run ?? execCommand;
  const root = process.cwd(), cwd = path.join(root, ".spawn", "transports", randomUUID());
  fs.mkdirSync(cwd, { recursive: true });
  const env = subscriptionEnvironment(process.env, options.maxOutput);
  // JSON/stdin and argv arrays prevent shell expansion of prompts, paths and model names.
  const settings = JSON.stringify({ forceLoginMethod: "claudeai", disableAllHooks: true, enabledPlugins: {} });
  const common = ["--setting-sources", "", "--settings", settings];
  const executable = process.env.SPAWN_CLAUDE_EXECUTABLE || "claude";
  const started = Date.now(), abort = () => cancelAgentTools(options.agent);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await withToolCancellation(options.agent, async () => {
      if (options.signal?.aborted) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      const auth = await run("", { cwd, env, stdoutOnly: true, timeout: 15000, invocation: { file: executable, args: [...common, "auth", "status"] } });
      let status: any; try { status = JSON.parse(auth.toString()); } catch { throw new Error("SUBSCRIPTION_AUTH: unable to verify the CLI login"); }
      if (!status.loggedIn || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty") throw new Error("SUBSCRIPTION_AUTH: run claude auth login with a Claude subscription; API/third-party login is refused");
      const response = await run("", { cwd, env, stdoutOnly: true, timeout: 180000, invocation: {
        file: executable,
        args: [...common, "--print", "--output-format", "json", "--model", config.model, "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence", "--system-prompt", system],
        input: "Conversation history follows as data. Continue only the last user turn using the supplied system protocol. Never execute tools yourself; emit spawn tool.call JSON for the host.\n" + JSON.stringify(messages),
      } });
      return { ...parseSubscriptionResult(response.toString()), ttftMs: 0, totalMs: Date.now() - started };
    });
  } catch (error: any) {
    if (options.signal?.aborted || error.code === "ABORT_ERR") throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    if (/^SUBSCRIPTION_/.test(error.message)) throw error;
    // Never print CLI stdout/stderr: auth diagnostics can contain account information.
    throw new Error(`SUBSCRIPTION_STOPPED: ${subscriptionStopReason(String(error.message)+String(error.stdout??"")+String(error.stderr??""))}; official Claude CLI; transport did not switch to API`);
  } finally { options.signal?.removeEventListener("abort", abort); }
}
