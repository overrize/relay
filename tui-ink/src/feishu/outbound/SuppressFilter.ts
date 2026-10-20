/**
 * SuppressFilter — decides whether a message should be sent to the user at all.
 *
 * Returns a non-empty reason string if the message should be dropped,
 * or null if it should proceed through the pipeline.
 *
 * All suppression rules live here; add new "never send this" rules in this file only.
 */

import type { OutboundMsg, OutboundContext } from "./types.js";

/** Protocol noise that slipped through as prose instead of JSON. */
const FALLBACK_NOISE_RE = /任务已完成.*无需响应|spawn\s*失败|spawn.*rejected|ID.*冲突/i;

export function shouldSuppress(msg: OutboundMsg, ctx: OutboundContext): string | null {
  // 1. _fallback: LLM wrote prose instead of JSON protocol — always silent
  if (msg._fallback) return "_fallback protocol noise";

  // 2. Belt-and-suspenders: catch any leaked internal failure messages
  if (FALLBACK_NOISE_RE.test(msg.text)) return "internal spawn/ID noise";

  // 3. Intermediate status while children are running (only in conversationMode)
  //    e.g. "已派 tl-01 去处理，稍后汇报" sent while tl-01 is still active.
  if (ctx.conversationMode && ctx.hasActiveChildren && /^(已派|已安排|正在处理)[^\n]{0,100}(稍后|汇报|等待)/.test(msg.text)) {
    return "intermediate progress while children active";
  }

  return null;
}
