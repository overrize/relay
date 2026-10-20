import { HttpConvAgent } from "../adapters/httpAgent.js";
import { SecretaryProxy } from "../memory/SecretaryProxy.js";
import { ProcessManager } from "../pm/ProcessManager.js";
import { TaskScheduler } from "./TaskScheduler.js";

export interface RuntimeContext {
  agents: Map<string, HttpConvAgent>;
  secretaries: Map<string, SecretaryProxy>;
  pm: ProcessManager;
  scheduledTasks: TaskScheduler;
  killedAgents: Set<string>;
  feishuBusy: Set<string>;
  pmPendingArtifacts: Map<string, string[]>;
  leaderApprovalQueue: Map<string, {
    workerAgent: HttpConvAgent;
    toolName: string;
    toolArgs: unknown;
    workerChildId: string; revision?: number;
  }>;
}

export function createRuntimeContext(): RuntimeContext {
  return {
    agents: new Map(),
    secretaries: new Map(),
    pm: new ProcessManager(),
    scheduledTasks: new TaskScheduler(),
    killedAgents: new Set(),
    feishuBusy: new Set(),
    pmPendingArtifacts: new Map(),
    leaderApprovalQueue: new Map(),
  };
}
