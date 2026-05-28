// `createJiraWebhookHandler` — Jira Cloud webhook receiver. A pure
// `(Request) => Promise<Response>` (same shape as the Slack/Zendesk/Intercom/
// Freshdesk receivers) that:
//   1. verifies Jira's `X-Hub-Signature: sha256=<hmac>` over the raw body,
//   2. dedups Jira's at-least-once retries,
//   3. scopes to an optional project allowlist,
//   4. normalizes the inbound payload with the same code the pull connector
//      uses (ADF→text, no-email user fields) and maps it to the same `jira.*`
//      episode kinds, then ingests it.
//
// Auth model: Jira **admin** webhooks (registered in Jira admin or via
// `/rest/webhooks/1.0/webhook`) take a `secret`; Jira then signs each callback
// with HMAC-SHA256 and sends it in `X-Hub-Signature: sha256=<hexdigest>`
// (developer.atlassian.com/cloud/jira/platform/webhooks). We verify that MAC
// in constant time over the exact raw body before doing anything else.

import { createHmac } from "node:crypto";
import {
  ConnectorError,
  redactEpisodeText,
  type RedactionOptions,
  type StatewaveEpisode,
} from "@statewavedev/connectors-core";
import { normalizeRawComment, normalizeRawIssue } from "./client.js";
import { mapJiraEvent } from "./mapper.js";
import type { JiraEvent } from "./types.js";
import { InMemoryJiraDedupCache, type JiraDedupCache } from "./webhook-dedup.js";
import type { JiraWebhookPayload } from "./webhook-types.js";

/** Shape of the ingest sink. Same contract as the other receivers. */
export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

const DEFAULT_SIGNATURE_HEADER = "x-hub-signature";
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]+$/;

export interface JiraWebhookConfig {
  /**
   * Webhook secret. Set it when registering the Jira admin webhook; Jira signs
   * each callback with HMAC-SHA256 and sends `X-Hub-Signature: sha256=<hmac>`.
   * Required — the handler refuses to start without it.
   */
  signingSecret: string;
  /** Override the signature header name (default `x-hub-signature`). */
  signatureHeader?: string;
  /**
   * Jira site base URL, e.g. `https://myorg.atlassian.net`. Used to mint the
   * same `/browse/<KEY>` permalinks the pull connector emits.
   */
  baseUrl: string;
  /**
   * Optional project-key allowlist. When set, events for projects outside it
   * are acked and skipped — a defense-in-depth scope on top of the JQL filter
   * you set on the Jira webhook itself. When unset, all projects are accepted.
   */
  projects?: ReadonlyArray<string>;
  /** Override the per-event default subject (`project:<KEY>`). */
  subject?: string;
  /** Redaction applied to episode text before ingest (parity with pull mode). */
  redaction?: RedactionOptions;
  /** Where to ship the resulting episode. Required unless `ingest` is provided. */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. */
  ingest?: StatewaveIngest;
  /** Replace the default in-memory dedup cache. */
  dedupCache?: JiraDedupCache;
  /** Logger sink — defaults to console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Inject `fetch` for tests + non-Node runtimes. */
  fetchImpl?: typeof fetch;
}

export interface JiraWebhookHandler {
  (req: Request): Promise<Response>;
  readonly dedupCache: JiraDedupCache;
}

export function createJiraWebhookHandler(config: JiraWebhookConfig): JiraWebhookHandler {
  if (!config.signingSecret) {
    throw new ConnectorError(
      "createJiraWebhookHandler requires signingSecret (the secret you set on the Jira admin webhook; Jira signs callbacks with it)",
      { code: "auth_missing", connector: "jira" },
    );
  }
  if (!config.baseUrl) {
    throw new ConnectorError("createJiraWebhookHandler requires baseUrl (e.g. https://myorg.atlassian.net)", {
      code: "config_invalid",
      connector: "jira",
    });
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError("createJiraWebhookHandler requires statewaveUrl or a custom ingest sink", {
      code: "config_invalid",
      connector: "jira",
    });
  }
  const allowlist = normalizeProjects(config.projects);
  const dedupCache = config.dedupCache ?? new InMemoryJiraDedupCache();
  const signatureHeader = (config.signatureHeader ?? DEFAULT_SIGNATURE_HEADER).toLowerCase();
  const ingest = config.ingest ?? buildHttpIngest(config);
  const logger = config.logger ?? defaultLogger;

  const handler = (async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    const signature = req.headers.get(signatureHeader);
    if (!signature) {
      return jsonResponse({ error: "missing_signature" }, 401);
    }

    let body: string;
    try {
      body = await req.text();
    } catch (err) {
      logger("warn", "jira webhook body read failed", { err: String(err) });
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    if (!verifySignature(config.signingSecret, body, signature)) {
      return jsonResponse({ error: "bad_signature" }, 401);
    }

    let payload: JiraWebhookPayload;
    try {
      payload = JSON.parse(body) as JiraWebhookPayload;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const event = mapInboundEvent(payload, config.baseUrl);
    if (!event) {
      return jsonResponse({ ok: true, ignored: "unsupported_event" }, 200);
    }
    if (allowlist && !allowlist.has(event.projectKey)) {
      return jsonResponse({ ok: true, ignored: "project_not_allowlisted" }, 200);
    }

    const eventId = synthesizeEventId(payload, event);
    const seen = await dedupCache.seenOrMark(eventId);
    if (seen) {
      return jsonResponse({ ok: true, deduplicated: true }, 200);
    }

    let episode = mapJiraEvent(event, { subject: config.subject });
    if (config.redaction) episode = redactEpisodeText(episode, config.redaction);

    try {
      await ingest(episode);
    } catch (err) {
      // Always 200 on ingest failure — Jira retries on non-2xx and the retry
      // rejoins our dedup window. Operators see failures via the logger sink.
      logger("error", "jira webhook ingest failed", { event_id: eventId, err: String(err) });
    }

    return jsonResponse({ ok: true, ingested: true }, 200);
  }) as JiraWebhookHandler;
  Object.defineProperty(handler, "dedupCache", { value: dedupCache, enumerable: true });
  return handler;
}

/**
 * Translate the inbound Jira payload into a normalized {@link JiraEvent}.
 * Returns null for events we don't map (deletes, unknown discriminators) so the
 * caller acks-and-skips rather than 4xx-ing on benign events.
 */
function mapInboundEvent(payload: JiraWebhookPayload, baseUrl: string): JiraEvent | null {
  const e = payload.webhookEvent;
  if ((e === "jira:issue_created" || e === "jira:issue_updated") && payload.issue?.key) {
    return normalizeRawIssue(payload.issue, baseUrl);
  }
  if ((e === "comment_created" || e === "comment_updated") && payload.comment?.id && payload.issue?.key) {
    const projectKey =
      payload.issue.fields?.project?.key ?? payload.issue.key.split("-")[0] ?? "UNKNOWN";
    return normalizeRawComment(payload.comment, payload.issue.key, projectKey, baseUrl);
  }
  return null;
}

function normalizeProjects(projects: ReadonlyArray<string> | undefined): Set<string> | null {
  if (!projects || projects.length === 0) return null;
  const out = new Set<string>();
  for (const p of projects) {
    const key = p.trim();
    if (!PROJECT_KEY.test(key)) {
      throw new ConnectorError(`invalid Jira project key "${p}"`, {
        code: "config_invalid",
        connector: "jira",
        hint: "project keys are letters/digits/underscores, e.g. ENG, PLAT2",
      });
    }
    out.add(key);
  }
  return out;
}

/**
 * Jira doesn't send a stable delivery id, so synthesize one from the event's
 * identity. Two genuinely distinct events differ; a retried delivery of the
 * same event collides (dedup wins).
 */
function synthesizeEventId(payload: JiraWebhookPayload, event: JiraEvent): string {
  const ts = payload.timestamp ?? "";
  if (event.type === "comment") {
    return `jira:${payload.webhookEvent}:${event.issueKey}:${event.id}:${event.updated}`;
  }
  return `jira:${payload.webhookEvent}:${event.key}:${event.updated}:${ts}`;
}

/**
 * Verify Jira's `X-Hub-Signature: sha256=<hex>` MAC over the raw body. Pinned to
 * SHA-256 (the algorithm Jira admin webhooks use) so a forged lower-strength
 * prefix can't downgrade the check.
 */
function verifySignature(secret: string, body: string, presented: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  return constantTimeEqual(expected, presented);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function buildHttpIngest(config: JiraWebhookConfig): StatewaveIngest {
  const url = config.statewaveUrl;
  if (!url) {
    throw new ConnectorError("statewaveUrl required when ingest is not provided", {
      code: "config_invalid",
      connector: "jira",
    });
  }
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return async (episode: StatewaveEpisode) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.statewaveApiKey) headers.authorization = `Bearer ${config.statewaveApiKey}`;
    if (config.statewaveTenantId) headers["x-statewave-tenant-id"] = config.statewaveTenantId;
    const res = await fetchImpl(`${url.replace(/\/$/, "")}/v1/episodes`, {
      method: "POST",
      headers,
      body: JSON.stringify(episode),
    });
    if (!res.ok) {
      throw new Error(`statewave ingest returned HTTP ${res.status}`);
    }
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultLogger: NonNullable<JiraWebhookConfig["logger"]> = (level, msg, ctx) => {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.error)(line);
};
