import type { TuiEvent } from "../protocol.js";
import { recordHealthMetric } from "../runtime/HealthMetrics.js";

const VALID_TYPES = new Set([
  "todo.set", "step", "tool.call", "tool.result", "message",
  "spawn", "agent.done", "agent.error", "agent.state",
  // S6 events
  "unit.handup", "memory.snapshot", "shutdown.start",
  "pm.alert", "proposal.new", "proposal.decision",
  // M1-4: explicit decision recording (primary; keyword regex is fallback)
  "decision.record",
  // Bash approval protocol: leader approves/rejects destructive worker commands
  "tool.approved", "tool.rejected",
  // Parent can kill a child agent
  "agent.kill",
]);

// Module-level counter — bare-text→message fallback is a prompt health metric.
let _fallbackWarnCount = 0;
export function getFallbackCount(): number { return _fallbackWarnCount; }
export function resetFallbackCount(): void  { _fallbackWarnCount = 0; }

// ── Pure protocol parser — extracted for testability ──────────────────────────
// Parses fullText (raw LLM output) into TuiEvents, calling emitFn for each.
// No HTTP, no class state — safe to import and test in isolation.
export function parseAgentOutput(
  fullText: string,
  agentId: string,
  emitFn: (ev: TuiEvent) => void,
): void {
  const VALID_JSON_ESC = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);
  const repairJsonLiterals = (s: string): string => {
    let out = "", inStr = false, esc = false;
    for (const ch of s) {
      if (esc) {
        esc = false;
        if (inStr && !VALID_JSON_ESC.has(ch)) { out += "\\" + ch; } else { out += ch; }
        continue;
      }
      if (ch === "\\" && inStr)   { esc = true;  out += ch; continue; }
      if (ch === '"')             { inStr = !inStr; out += ch; continue; }
      if (inStr && ch === "\n")   { out += "\\n"; continue; }
      if (inStr && ch === "\r")   { out += "\\r"; continue; }
      if (inStr && ch === "\t")   { out += "\\t"; continue; }
      out += ch;
    }
    return out;
  };

  const recordProtocolMetric = (
    event_type: "protocol_parse_failed" | "protocol_repaired" | "fallback_message_emitted",
    severity: "info" | "warn" | "error",
    reason: string,
    raw: string,
    meta?: Record<string, unknown>,
  ) => {
    recordHealthMetric({
      agent_id: agentId,
      event_type,
      severity,
      reason,
      refs: [raw.slice(0, 500)],
      meta,
    });
  };

  const emitParsed = (raw: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const repaired = repairJsonLiterals(raw);
      try {
        parsed = JSON.parse(repaired);
        if (repaired !== raw) {
          recordProtocolMetric("protocol_repaired", "warn", "json_literal_repaired", raw);
        }
      } catch (e2) {
        let closed: any = null;
        let closingBraces = 0;
        for (let extra = 1; extra <= 3; extra++) {
          try {
            closed = JSON.parse(repaired + "}".repeat(extra));
            closingBraces = extra;
            break;
          } catch { /* try more */ }
        }
        if (closed) {
          parsed = closed;
          recordProtocolMetric("protocol_repaired", "warn", "json_closing_braces_repaired", raw, { closingBraces });
        } else {
          process.stderr.write(
            `[${agentId}] JSON parse FAILED: ${(e2 as Error).message}\n` +
            `  raw(${raw.length}): ${raw.slice(0, 300)}\n`,
          );
          if (raw.trim().startsWith("{")) {
            recordProtocolMetric("protocol_parse_failed", "error", (e2 as Error).message, raw);
          }
          parsed = null;
        }
      }
    }
    if (parsed) try {
      if (parsed?.type === "think") {
        const thought = String(parsed.thought ?? parsed.text ?? "").slice(0, 120);
        if (thought) emitFn({ v: 1, type: "step", agent: agentId, text: `💭 ${thought}` } as TuiEvent);
        return;
      }
      if (parsed?.type && VALID_TYPES.has(String(parsed.type))) {
        const ev = { v: 1 as const, ...parsed, agent: parsed.agent ?? agentId } as TuiEvent;
        emitFn(ev);
        return;
      }
      // Parsed JSON with a type field not in protocol (e.g. type:planning, type:response).
      // Silently drop — never display raw JSON blobs to the user.
      if (parsed?.type) {
        process.stderr.write(`[${agentId}] unknown event type "${parsed.type}", dropped\n`);
        return;
      }
    } catch { /* not valid protocol JSON */ }
    // Plain-text "agent.done" signal — agent tried to quit via natural language instead of JSON.
    // Synthesize the event so the system actually stops invoking it.
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && /agent\.done/.test(raw)) {
      process.stderr.write(`[${agentId}] plain-text agent.done detected, synthesizing event\n`);
      recordProtocolMetric("protocol_repaired", "warn", "plain_text_agent_done_synthesized", raw);
      emitFn({ v: 1, type: "agent.done", agent: agentId, success: true,
               reason: raw.trim().slice(0, 200) } as TuiEvent);
      return;
    }
    // Drop output that looks like JSON but failed to parse or had no type field.
    // These are protocol blobs the LLM corrupted — showing raw JSON to the user is noise.
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      process.stderr.write(`[${agentId}] raw JSON-like output dropped: ${trimmed.slice(0, 120)}\n`);
      return;
    }
    _fallbackWarnCount++;
    process.stderr.write(`[${agentId}] PROMPT_HEALTH fallback #${_fallbackWarnCount}: ${trimmed.slice(0, 80)}\n`);
    recordProtocolMetric("fallback_message_emitted", "warn", "plain_text_protocol_fallback", trimmed, {
      fallbackCount: _fallbackWarnCount,
    });
    emitFn({ v: 1, type: "message", agent: agentId, to: "user", text: trimmed, _fallback: true } as TuiEvent);
  };

  let jsonBuf = "";
  let depth = 0;
  let jsonInStr = false;
  let jsonEsc = false;
  let inThinking = false;
  let thinkingStepEmitted = false;

  for (const line of fullText.split("\n")) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) continue;
    if (!inThinking && trimmed.includes("<thinking>")) {
      inThinking = true;
      if (!thinkingStepEmitted) {
        thinkingStepEmitted = true;
        emitFn({ v: 1, type: "step", agent: agentId, text: "thinking…" } as TuiEvent);
      }
    }
    if (inThinking) {
      if (trimmed.includes("</thinking>")) inThinking = false;
      continue;
    }
    if (!trimmed) {
      if (depth === 0 && !jsonInStr && jsonBuf) {
        emitParsed(jsonBuf); jsonBuf = ""; jsonInStr = false; jsonEsc = false;
      }
      continue;
    }
    if (depth === 0 && !jsonInStr && !trimmed.startsWith("{")) {
      if (jsonBuf) { emitParsed(jsonBuf); jsonBuf = ""; jsonInStr = false; jsonEsc = false; }
      const inlineJson = trimmed.indexOf('{"');
      if (inlineJson > 0) {
        const prose = trimmed.slice(0, inlineJson).trim();
        if (prose) emitParsed(prose);
        const jsonPart = trimmed.slice(inlineJson);
        jsonBuf = jsonPart;
        for (const ch of jsonPart) {
          if (jsonEsc)                  { jsonEsc = false; continue; }
          if (ch === "\\" && jsonInStr) { jsonEsc = true; continue; }
          if (ch === '"')               { jsonInStr = !jsonInStr; continue; }
          if (jsonInStr)                continue;
          if (ch === "{")  depth++;
          else if (ch === "}") depth--;
        }
        if (depth <= 0 && !jsonInStr) {
          emitParsed(jsonBuf); jsonBuf = ""; depth = 0; jsonInStr = false; jsonEsc = false;
        }
      } else {
        emitParsed(trimmed);
      }
      continue;
    }
    jsonBuf += (jsonBuf ? "\n" : "") + trimmed;
    for (const ch of trimmed) {
      if (jsonEsc)               { jsonEsc = false; continue; }
      if (ch === "\\" && jsonInStr) { jsonEsc = true; continue; }
      if (ch === '"')            { jsonInStr = !jsonInStr; continue; }
      if (jsonInStr)             continue;
      if (ch === "{")            depth++;
      else if (ch === "}")       depth--;
    }
    if (depth <= 0 && !jsonInStr) {
      emitParsed(jsonBuf);
      jsonBuf = ""; depth = 0; jsonInStr = false; jsonEsc = false;
    }
  }
  if (jsonBuf.trim()) emitParsed(jsonBuf);
}

