/**
 * HandlerContext — shared injected runtime deps for the split Leader/Worker
 * handlers (spawn-1.0 M1-6e). configureAgentHandlers() sets them once; each handler
 * reads via getHandlerDeps().
 */
import type { HttpConvAgent } from "../adapters/httpAgent.js";
import type { ProcessManager } from "../pm/ProcessManager.js";
import type { SecretaryProxy } from "./MemoryRuntime.js";

export interface HandlerDeps {
  agents: Map<string, HttpConvAgent>;
  killedAgents: Set<string>;
  pm: ProcessManager;
  feishuBusy: Set<string>;
  secretaries: Map<string, SecretaryProxy>;
  pmPendingArtifacts: Map<string, string[]>;
  leaderApprovalQueue: Map<string, { workerAgent: HttpConvAgent; toolName: string; toolArgs: unknown; workerChildId: string; revision?: number }>;
  buildSystemPrompt: (role: "Leader" | "Secretary" | "Worker", agentId: string, goal?: string, resumedMemoryId?: string, promptFile?: string) => string;
  killAgent: (id: string, reason?: string) => void;
  MODEL: string;
  DEMO: boolean;
}
let _deps: HandlerDeps | null = null;
export function configureAgentHandlers(deps: HandlerDeps): void { _deps = deps; }
export function getHandlerDeps(): HandlerDeps { return _deps!; }
