// `statewave-connectors listen <connector>` — start a tiny built-in HTTP
// server that wraps a connector's webhook handler. Currently only the
// Slack live-mode handler is hooked up; new push-mode connectors can
// register here as they ship.
//
// We use Node's `http` module directly (no Express dep) and adapt
// IncomingMessage → Request → handler → ServerResponse so the same pure
// `(Request) => Response` function the user can mount on Vercel /
// Cloudflare runs unchanged here. That keeps the deploy story consistent:
// the handler is the unit, this command is just one of several places it
// can be hosted.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConnectorError } from "@statewavedev/connectors-core";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsInt, flagAsList, flagAsString } from "../args.js";
import { readStatewaveEnv } from "../env.js";
import { Output } from "../output.js";

const KNOWN_CONNECTORS = new Set(["slack"]);

export async function runListen(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const [, source] = args.positional;
  if (!source) {
    out.error(
      "missing connector name",
      "usage: statewave-connectors listen <connector> [options]",
    );
    return 2;
  }
  if (!KNOWN_CONNECTORS.has(source)) {
    out.error(
      `unknown connector: ${source}`,
      `supported: ${[...KNOWN_CONNECTORS].join(", ")}`,
    );
    return 2;
  }

  const port = flagAsInt(args, "port") ?? 3000;
  const host = flagAsString(args, "host") ?? "0.0.0.0";
  const path = flagAsString(args, "path") ?? "/slack/events";

  let handler: (req: Request) => Promise<Response>;
  try {
    handler = await loadHandler(source, args);
  } catch (err) {
    return reportError(out, err);
  }

  const server = createServer((req, res) => void adaptToFetchHandler(req, res, path, handler));
  server.listen(port, host, () => {
    if (out.isJson()) {
      out.data({ source, host, port, path, status: "listening" });
    } else {
      out.log(`statewave-connectors listen ${source}`);
      out.log(`  → http://${host}:${port}${path}`);
      out.log(`  Ctrl-C to stop`);
    }
  });
  return new Promise<number>((resolve) => {
    const stop = (code: number) => {
      server.close(() => resolve(code));
    };
    process.on("SIGINT", () => stop(0));
    process.on("SIGTERM", () => stop(0));
  });
}

async function loadHandler(
  source: string,
  args: ParsedArgs,
): Promise<(req: Request) => Promise<Response>> {
  if (source !== "slack") {
    throw new ConnectorError(`listen: ${source} not yet supported`, {
      code: "unsupported",
      hint: `supported: ${[...KNOWN_CONNECTORS].join(", ")}`,
    });
  }

  const mod = await import("@statewavedev/connectors-slack");
  const env = readStatewaveEnv();
  const signingSecret =
    flagAsString(args, "signing-secret") ?? process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new ConnectorError(
      "SLACK_SIGNING_SECRET is required for slack listen",
      {
        code: "auth_missing",
        connector: "slack",
        hint:
          "find it under Slack app → Basic Information → App-Level Signing Secret, " +
          "then export SLACK_SIGNING_SECRET=… or pass --signing-secret",
      },
    );
  }
  const channels = flagAsList(args, "channels");
  if (!channels || channels.length === 0) {
    throw new ConnectorError(
      "--channels is required for slack listen (comma-separated channel ids C…)",
      {
        code: "config_invalid",
        connector: "slack",
        hint:
          "Slack Events-API only delivers IDs (not names), so the allowlist " +
          "has to use IDs too. Find them in Slack: channel name → settings → bottom of dialog.",
      },
    );
  }
  if (!env.url) {
    throw new ConnectorError("STATEWAVE_URL is required for slack listen", {
      code: "config_invalid",
      connector: "slack",
    });
  }

  return mod.createSlackWebhookHandler({
    signingSecret,
    channels,
    statewaveUrl: env.url,
    statewaveApiKey: env.apiKey,
    statewaveTenantId: env.tenantId,
  });
}

/**
 * Adapter: Node `IncomingMessage` → fetch `Request` → run the handler →
 * fetch `Response` → Node `ServerResponse`. We collect the body up-front
 * because Slack always sends small POST bodies (a few KB at most) and
 * the signature check needs the raw bytes anyway.
 */
async function adaptToFetchHandler(
  req: IncomingMessage,
  res: ServerResponse,
  expectedPath: string,
  handler: (req: Request) => Promise<Response>,
): Promise<void> {
  // Reject anything outside the expected path; helps surface mis-configured
  // event subscriptions during Slack app setup instead of silently 401-ing
  // the signature check.
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== expectedPath) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not_found", expected: expectedPath }));
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  const fetchReq = new Request(`http://localhost${url.pathname}`, {
    method: req.method ?? "GET",
    headers,
    body: body.length > 0 ? body : undefined,
  });

  let response: Response;
  try {
    response = await handler(fetchReq);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "handler_threw", message: (err as Error).message }));
    return;
  }
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const respBody = await response.text();
  res.end(respBody);
}

function reportError(out: Output, err: unknown): number {
  if (err instanceof ConnectorError) {
    out.error(err.message, err.hint);
    return err.code === "config_invalid" || err.code === "auth_missing" ? 2 : 1;
  }
  out.error(err instanceof Error ? err.message : String(err));
  return 1;
}
