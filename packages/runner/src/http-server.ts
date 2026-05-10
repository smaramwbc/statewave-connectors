// HTTP server that multiplexes every push receiver under one Node
// `node:http` server, plus the runner's own `/healthz` + `/readyz`
// endpoints.
//
// Adapter shape mirrors `packages/cli/src/commands/listen.ts` —
// IncomingMessage → fetch Request → handler → fetch Response →
// ServerResponse — so the same `(Request) => Promise<Response>` push
// receivers run unchanged here.
//
// Health semantics:
//   /healthz — 200 once the HTTP server is listening, regardless of
//              connector state. Liveness signal for orchestrators.
//   /readyz  — 200 when the runner has finished startup AND no push
//              handler returned an irrecoverable load error. Pre-start,
//              503. Post-graceful-shutdown, 503.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Logger } from "./logger.js";
import type { MetricsAuthCheck } from "./metrics/auth.js";
import type { Metrics } from "./metrics/registry.js";
import type { PushHandler } from "./push-adapters.js";

export interface PushMount {
  /** `slack`, `gmail`, etc. */
  kind: string;
  /** `team-events`, `founder-pubsub`, etc. */
  name: string;
  handler: PushHandler;
  /** Mounted path. Always `/<kind>/<name>/events`. */
  path: string;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  mounts: ReadonlyArray<PushMount>;
  logger: Logger;
  /** Runner's startup state. The server reads this on every `/readyz`
   * hit. Flipped to `true` once the runner finishes its boot sequence;
   * back to `false` on graceful shutdown. */
  readinessRef: { ready: boolean };
  /** Metrics registry. The server exposes it on `metricsPath` (default
   * `/metrics`). Operators set auth via `metricsAuth` when the runner's
   * port is reachable from the public internet — health endpoints stay
   * unauthenticated regardless. */
  metrics: Metrics;
  metricsPath: string;
  metricsAuth: MetricsAuthCheck;
}

export interface RunnerHttpServer {
  /** Begin listening. Returns when the OS has bound the port. */
  start(): Promise<{ host: string; port: number }>;
  /** Stop accepting new requests, drain in-flight, then close. */
  stop(): Promise<void>;
}

export function createHttpServer(options: HttpServerOptions): RunnerHttpServer {
  const mountMap = new Map(options.mounts.map((m) => [m.path, m]));
  let server: Server | undefined;

  return {
    async start() {
      server = createServer((req, res) => void route(req, res, mountMap, options));
      await new Promise<void>((resolve) => {
        server!.listen(options.port, options.host, () => resolve());
      });
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        return { host: options.host, port: addr.port };
      }
      return { host: options.host, port: options.port };
    },
    async stop() {
      const s = server;
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
      server = undefined;
    },
  };
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  mounts: Map<string, PushMount>,
  options: HttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    return jsonResponse(res, 200, { status: "ok" });
  }
  if (url.pathname === "/readyz") {
    if (options.readinessRef.ready) {
      return jsonResponse(res, 200, { status: "ready" });
    }
    return jsonResponse(res, 503, { status: "starting_or_shutting_down" });
  }
  if (url.pathname === options.metricsPath) {
    return handleMetrics(req, res, options);
  }

  const mount = mounts.get(url.pathname);
  if (!mount) {
    return jsonResponse(res, 404, {
      error: "not_found",
      hint: `mounted: ${[...mounts.keys()].join(", ") || "(no push receivers configured)"}`,
    });
  }

  await dispatchToFetchHandler(req, res, mount, options.logger);
}

async function handleMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
): Promise<void> {
  // Build a fetch-Request just for the auth header check — the rest
  // of the handler stays in plain Node http, so we don't pay the
  // body-buffering cost just to read one header.
  const authHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    authHeaders.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }
  const fetchReq = new Request("http://localhost/metrics", {
    method: req.method ?? "GET",
    headers: authHeaders,
  });
  if (!options.metricsAuth.authorize(fetchReq)) {
    res.statusCode = 401;
    // RFC 7235: include WWW-Authenticate so curl + browsers know how
    // to retry with credentials. We don't disclose which auth mode is
    // configured (basic vs bearer) — that's a small fingerprinting win.
    res.setHeader("WWW-Authenticate", 'Basic realm="metrics", Bearer');
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  let body: string;
  try {
    body = await options.metrics.registry.metrics();
  } catch (err) {
    options.logger.error("metrics encode failed", { err: String(err) });
    res.statusCode = 500;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", options.metrics.registry.contentType);
  res.end(body);
}

async function dispatchToFetchHandler(
  req: IncomingMessage,
  res: ServerResponse,
  mount: PushMount,
  logger: Logger,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  const fetchReq = new Request(`http://localhost${url.pathname}${url.search}`, {
    method: req.method ?? "GET",
    headers,
    body: body.length > 0 ? body : undefined,
  });

  let response: Response;
  try {
    response = await mount.handler(fetchReq);
  } catch (err) {
    logger.error(`[${mount.kind}/${mount.name}] handler threw`, { err: String(err) });
    return jsonResponse(res, 500, { error: "handler_threw" });
  }
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const respBody = await response.text();
  res.end(respBody);
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
