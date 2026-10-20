import { estimateTokens } from "./tokens.js";

export function clipTokens(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (estimateTokens(text) <= budget) return text;
  const marker = "\n[truncated]";
  if (estimateTokens(marker) > budget) return "";
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + marker) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + marker;
}

/** Retain the initial goal and recent turns, but enforce a hard estimated cap. */
export function budgetHistory<T extends { content: string }>(messages: T[], budget: number): T[] {
  if (budget <= 0) return [];
  const clean = messages.filter((m) => typeof m.content === "string" && m.content.trim());
  if (clean.reduce((n, m) => n + estimateTokens(m.content), 0) <= budget) return clean.slice();
  const result: T[] = [];
  let remaining = budget;
  const first = clean[0];
  if (first && clean.length > 1) {
    const content = clipTokens(first.content, Math.floor(budget / 4));
    if (content) { result.push({ ...first, content }); remaining -= estimateTokens(content); }
  }
  const tail: T[] = [];
  for (let i = clean.length - 1; i >= (clean.length > 1 ? 1 : 0); i--) {
    const m = clean[i]!;
    const content = clipTokens(m.content, remaining);
    if (!content) break;
    tail.unshift({ ...m, content });
    remaining -= estimateTokens(content);
    if (remaining <= 0 || content !== m.content) break;
  }
  return result.concat(tail);
}
