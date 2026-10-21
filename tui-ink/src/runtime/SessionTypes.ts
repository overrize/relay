import type {TuiEvent} from "../protocol.js";
export interface LeaderOpts {
  deferInitial?:boolean;
  id: string;
  parentId?: string;
  goal?: string;
  model?: string;
  depth?: number;
  parentChain?: string[];
  dispatch?: Extract<TuiEvent, { type: "spawn" }>["dispatch"];
  resumedMemoryId?: string;
  promptFile?: string;      // "pm" for root, "leader" for tech leads
  firstMessage?: string;    // override initial LLM message (used when PM first starts)
  replyHook?: (text: string, format?: "text" | "document", meta?: { _fallback?: boolean; agentId?: string }) => void; // called when message.to=user (Feishu bridge)
  turnEndHook?: () => void;            // called when Feishu PM turn ends — flushes aggregator
  conversationMode?: boolean;          // if true: stop after each user reply, no auto-nudge
  // Phase B: forked task options
  sharedSystemPrompt?: string;         // exact system prompt from base PM (enables cache reuse)
  initialMessages?: Array<{ role: "user" | "assistant"; content: string }>; // history snapshot
  inputId?: string;
  isForkedTask?: boolean;              // concurrent task with its own persisted secretary
}
