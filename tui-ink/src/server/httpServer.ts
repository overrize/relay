import http from "node:http";
import { getState, userMessage } from "../store.js";

// ── Configuration ────────────────────────────────────────────────────────────────

export interface HttpServerConfig {
  enabled: boolean;
  port: number;
  onMessage?: (text: string, inputId?: string) => void;
}

export function defaultConfig(): HttpServerConfig {
  return { enabled: true, port: 3001 };
}

// ── Request body parsing ─────────────────────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) {
          return reject(new Error("Body must be a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data) + "\n");
}

// ── Handlers ──────────────────────────────────────────────────────────────────────

function handleGetStatus(res: http.ServerResponse, startedAt: number): void {
  const state = getState();
  const agents = Array.from(state.agents.values());
  const runningAgents = agents.filter((a) => a.state === "run");

  jsonResponse(res, 200, {
    agent_count: agents.length,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    pm_state: agents.length > 0 ? "active" : "idle",
    active_tasks: runningAgents.map((a) => ({
      id: a.id,
      role: a.role,
      goal: a.goal ?? a.sub ?? "",
      state: a.state,
      parent: a.parent,
    })),
  });
}

function handlePostMessage(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  onMessage?: HttpServerConfig["onMessage"],
): void {
  const text = body.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return jsonResponse(res, 400, { error: "Missing or invalid 'text' field (must be a non-empty string)" });
  }

  const from = typeof body.from === "string" ? body.from.trim() : "http-api";

  // Push message to PM's inbox using the store API
  onMessage?.(text.trim(), typeof body.id === "string" ? body.id : undefined);
  userMessage("pm", `[${from}] ${text.trim()}`);

  jsonResponse(res, 200, { status: "accepted", text: text.trim(), from });
}

// ── Server factory ───────────────────────────────────────────────────────────────

export function createHttpServer(config?: Partial<HttpServerConfig>): http.Server {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    // CORS headers for external webhook calls
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/status") {
        return handleGetStatus(res, startedAt);
      }

      if (req.method === "POST" && path === "/message") {
        const body = await parseBody(req);
        return handlePostMessage(res, body, config?.onMessage);
      }

      // 404 for anything else
      jsonResponse(res, 404, { error: `Not found: ${req.method} ${path}` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 400, { error: msg });
    }
  });

  return server;
}

// ── Start helper ─────────────────────────────────────────────────────────────────

export function startHttpServer(config?: Partial<HttpServerConfig>): http.Server | null {
  const cfg: HttpServerConfig = { ...defaultConfig(), ...config };
  if (!cfg.enabled) return null;

  const server = createHttpServer(cfg);
  server.listen(cfg.port, () => {
    console.error(`[http-server] REST API listening on http://localhost:${cfg.port}`);
  });
  server.unref(); // Don't prevent process exit
  return server;
}
