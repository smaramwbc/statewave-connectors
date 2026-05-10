// `createGmailPubsubHandler` — Gmail Pub/Sub push receiver. Same pure
// `(Request) => Promise<Response>` shape as the Slack/Freshdesk/Zendesk/
// Intercom receivers, but the upstream model is fundamentally different:
// Gmail doesn't deliver event payloads directly. It publishes a "your
// mailbox changed, here's the new historyId" pointer to a Cloud Pub/Sub
// topic; Pub/Sub's push subscription then POSTs that pointer to the
// configured URL. The receiver decodes the pointer, walks Gmail's
// History API from the last-persisted historyId forward, and ingests
// each newly-arrived message as a `gmail.message.received` /
// `gmail.message.sent` episode (same shapes the pull connector emits).
//
// Auth model: path-token. Pub/Sub push subscriptions don't carry a
// signed body the way native HTTP webhooks do — Google's recommended
// pattern is either OIDC token verification or a "URL with a secret
// token" (a random string the operator chooses and configures on the
// subscription URL). v0.2.0 ships path-token only; OIDC verification
// is queued for a follow-up since it requires fetching + caching
// Google's JWKs and verifying RS256 JWTs. Operators who want OIDC
// today can plug a `verifyAuth` callback that runs before the standard
// path-token check.
//
// Cursor model: persistent. Unlike the HTTP webhook receivers (which
// only need event-id dedup), this receiver also needs to remember the
// last-seen historyId across deliveries — without it the History API
// walk would either redeliver everything or skip messages on the next
// notification. The default in-memory store is fine for single-process
// daemons that don't restart often; production deploys plug in Redis
// or Postgres.
//
// Episode kinds dispatched: `gmail.message.received`, `gmail.message.sent`
// (same as pull mode; classified by SENT-label presence).

import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";
import { GmailClient } from "./client.js";
import { classifyMessage, mapGmailEvent } from "./mapper.js";
import type { GmailMessage, GmailOAuthCredentials } from "./types.js";
import {
  type GmailHistoryCursorStore,
  type GmailPubsubDedupCache,
  InMemoryGmailHistoryCursorStore,
  InMemoryGmailPubsubDedupCache,
} from "./webhook-cursor.js";
import type {
  GmailWatchPayload,
  PubsubPushEnvelope,
} from "./webhook-types.js";

/** Shape of the ingest sink. Same contract as the other receivers. */
export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

/**
 * Subset of `GmailClient` the receiver needs at runtime. Stubbed in
 * tests so we don't have to spin up the full OAuth dance + Gmail API
 * fixture for every webhook test.
 */
export interface GmailHistoryReader {
  listHistoryMessages(options: {
    startHistoryId: string;
    query?: string;
    labelIds?: ReadonlyArray<string>;
    maxItems?: number;
  }): Promise<{
    messages: ReadonlyArray<GmailMessage>;
    nextHistoryId?: string;
    tooOld: boolean;
  }>;
  getProfile(): Promise<{ historyId?: string; emailAddress?: string }>;
}

export interface GmailPubsubReceiverConfig {
  /**
   * Path-token the operator configures on the Pub/Sub subscription URL
   * (e.g. `https://you.example.com/gmail/events?token=<random>`). The
   * receiver requires this match before processing the body.
   *
   * Set this OR provide a `verifyAuth` callback. At least one form of
   * auth is required.
   */
  pathToken?: string;
  /**
   * Custom auth verifier. Runs before the path-token check; if it
   * returns false the request is rejected with 401. Use this to plug
   * in OIDC verification (Google signs Pub/Sub push delivery tokens
   * with its OIDC keys; you can verify the JWT in `Authorization:
   * Bearer <id_token>` against your subscription's `aud` claim).
   */
  verifyAuth?: (req: Request) => boolean | Promise<boolean>;
  /** Optional explicit query-string parameter name for the path-token
   * (default `token`). */
  tokenParam?: string;

  /**
   * Gmail OAuth credentials. Required so the receiver can call the
   * Gmail History + Messages APIs to fetch the actual messages a
   * Pub/Sub notification points to. Same shape as pull mode.
   *
   * Optional iff `historyReader` is provided (used in tests).
   */
  credentials?: GmailOAuthCredentials;
  /** Inject a custom Gmail history reader (overrides the built-in
   * `GmailClient`). Mostly for tests. */
  historyReader?: GmailHistoryReader;

  /**
   * Gmail search query to filter on. Same semantics as pull mode's
   * `--query` — applied client-side after the History API returns.
   * Optional; if omitted, every newly-arrived message turns into an
   * episode (operators almost always want a filter).
   */
  query?: string;
  /**
   * Typed Gmail label-id allowlist (e.g. `INBOX`, `IMPORTANT`,
   * `Label_xyz`). Pushed to the History API server-side filter (AND
   * semantics).
   */
  labelIds?: ReadonlyArray<string>;
  /** Cap mapped episodes per delivery. Default unlimited. */
  maxItems?: number;
  /** Override subject. Defaults to `relationship:<other_email>` per message. */
  subject?: string;

  /**
   * Where to ship the resulting episode(s). Required unless `ingest`
   * is provided.
   */
  statewaveUrl?: string;
  statewaveApiKey?: string;
  statewaveTenantId?: string;
  /** Custom ingest sink — overrides the built-in HTTP one. */
  ingest?: StatewaveIngest;

  /** Persistent history-cursor store. Defaults to in-memory. */
  historyCursorStore?: GmailHistoryCursorStore;
  /** Pub/Sub messageId dedup cache. Defaults to in-memory. */
  dedupCache?: GmailPubsubDedupCache;

  /** Logger sink — defaults to console.error. */
  logger?: (level: "info" | "warn" | "error", msg: string, ctx?: unknown) => void;
  /** Inject `fetch` for tests + non-Node runtimes (only used by the
   * built-in HTTP ingest). */
  fetchImpl?: typeof fetch;
}

export interface GmailPubsubHandler {
  (req: Request): Promise<Response>;
  readonly historyCursorStore: GmailHistoryCursorStore;
  readonly dedupCache: GmailPubsubDedupCache;
}

export function createGmailPubsubHandler(
  config: GmailPubsubReceiverConfig,
): GmailPubsubHandler {
  if (!config.pathToken && !config.verifyAuth) {
    throw new ConnectorError(
      "createGmailPubsubHandler requires pathToken or a verifyAuth callback",
      { code: "config_invalid", connector: "gmail" },
    );
  }
  if (!config.historyReader && !config.credentials) {
    throw new ConnectorError(
      "createGmailPubsubHandler requires credentials (or a historyReader for tests)",
      { code: "config_invalid", connector: "gmail" },
    );
  }
  if (!config.ingest && !config.statewaveUrl) {
    throw new ConnectorError(
      "createGmailPubsubHandler requires statewaveUrl or a custom ingest sink",
      { code: "config_invalid", connector: "gmail" },
    );
  }

  const historyReader: GmailHistoryReader =
    config.historyReader ?? new GmailClient({ credentials: config.credentials! });
  const historyCursorStore = config.historyCursorStore ?? new InMemoryGmailHistoryCursorStore();
  const dedupCache = config.dedupCache ?? new InMemoryGmailPubsubDedupCache();
  const tokenParam = config.tokenParam ?? "token";
  const ingest = config.ingest ?? buildHttpIngest(config);
  const logger = config.logger ?? defaultLogger;

  const handler = (async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    if (config.verifyAuth) {
      const ok = await config.verifyAuth(req);
      if (!ok) return jsonResponse({ error: "unauthorized" }, 401);
    } else if (config.pathToken) {
      // Accept the token either in the URL path (`.../<token>`) or as
      // a query-string parameter (`?token=<…>`) — Pub/Sub subscriptions
      // can be configured either way and the receiver shouldn't care.
      const url = new URL(req.url);
      const queryToken = url.searchParams.get(tokenParam);
      const pathSuffix = url.pathname.split("/").pop() ?? "";
      const presented = queryToken ?? pathSuffix;
      if (!constantTimeEqual(presented, config.pathToken)) {
        return jsonResponse({ error: "bad_token" }, 401);
      }
    }

    let body: string;
    try {
      body = await req.text();
    } catch (err) {
      logger("warn", "gmail pubsub body read failed", { err: String(err) });
      return jsonResponse({ error: "body_read_failed" }, 400);
    }

    let envelope: PubsubPushEnvelope;
    try {
      envelope = JSON.parse(body) as PubsubPushEnvelope;
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    if (!envelope?.message?.data) {
      return jsonResponse({ ok: true, ignored: "missing_message_data" }, 200);
    }
    const messageId = envelope.message.messageId;
    if (messageId) {
      const seen = await dedupCache.seenOrMark(messageId);
      if (seen) {
        return jsonResponse({ ok: true, deduplicated: true }, 200);
      }
    }

    let payload: GmailWatchPayload;
    try {
      const decoded = decodeBase64(envelope.message.data);
      payload = JSON.parse(decoded) as GmailWatchPayload;
    } catch (err) {
      logger("warn", "gmail pubsub data decode failed", { err: String(err) });
      return jsonResponse({ error: "bad_data_payload" }, 400);
    }

    if (!payload?.emailAddress || payload?.historyId === undefined) {
      return jsonResponse({ ok: true, ignored: "missing_watch_fields" }, 200);
    }

    const incomingHistoryId = String(payload.historyId);
    const lastSeen = await historyCursorStore.get(payload.emailAddress);

    // Cold-start delivery: nothing to walk back to. Persist the
    // notification's historyId so the next delivery has a baseline,
    // and ack — operators don't expect Pub/Sub to backfill mail that
    // arrived before the watch was started.
    if (!lastSeen) {
      await historyCursorStore.set(payload.emailAddress, incomingHistoryId);
      return jsonResponse(
        { ok: true, ingested: 0, cold_start: true, history_id: incomingHistoryId },
        200,
      );
    }

    let walk: Awaited<ReturnType<GmailHistoryReader["listHistoryMessages"]>>;
    try {
      walk = await historyReader.listHistoryMessages({
        startHistoryId: lastSeen,
        query: config.query,
        labelIds: config.labelIds,
        maxItems: config.maxItems,
      });
    } catch (err) {
      logger("error", "gmail history walk failed", {
        emailAddress: payload.emailAddress,
        startHistoryId: lastSeen,
        err: String(err),
      });
      // Always 200 so Pub/Sub doesn't retry-storm transient Gmail
      // hiccups; the cursor stays put so the next notification will
      // re-attempt the same window.
      return jsonResponse({ ok: true, ingested: 0, walk_failed: true }, 200);
    }

    if (walk.tooOld) {
      // Gmail returned 404 on the History endpoint — the cursor is
      // older than ~7 days. We ack and reset the cursor to the latest
      // historyId so the next notification doesn't keep failing the
      // same way; operators see this in the logs and should re-run a
      // cold-start pull connector to backfill the window we lost.
      logger("warn", "gmail history cursor too old; resetting", {
        emailAddress: payload.emailAddress,
        droppedHistoryId: lastSeen,
      });
      await historyCursorStore.set(payload.emailAddress, incomingHistoryId);
      return jsonResponse(
        { ok: true, ingested: 0, cursor_too_old: true, history_id: incomingHistoryId },
        200,
      );
    }

    let ingested = 0;
    for (const message of walk.messages) {
      const event = classifyMessage(message);
      const episode = mapGmailEvent(event, { subject: config.subject });
      try {
        await ingest(episode);
        ingested += 1;
      } catch (err) {
        // One bad ingest shouldn't tank the whole delivery. Log and
        // move on — Pub/Sub will retry the whole envelope, and dedup
        // by messageId will gate that. Cursor advancement waits until
        // we've at least *attempted* every message in this window, so
        // we don't lose track of where we are.
        logger("error", "gmail webhook ingest failed", {
          message_id: message.id,
          err: String(err),
        });
      }
    }

    // Persist the highest historyId we walked to (or the incoming
    // notification's historyId if Gmail didn't return a `nextHistoryId`).
    const nextCursor = walk.nextHistoryId ?? incomingHistoryId;
    await historyCursorStore.set(payload.emailAddress, nextCursor);

    return jsonResponse(
      { ok: true, ingested, history_id: nextCursor },
      200,
    );
  }) as GmailPubsubHandler;
  Object.defineProperty(handler, "historyCursorStore", {
    value: historyCursorStore,
    enumerable: true,
  });
  Object.defineProperty(handler, "dedupCache", { value: dedupCache, enumerable: true });
  return handler;
}

function buildHttpIngest(config: GmailPubsubReceiverConfig): StatewaveIngest {
  const url = config.statewaveUrl;
  if (!url) {
    throw new ConnectorError("statewaveUrl required when ingest is not provided", {
      code: "config_invalid",
      connector: "gmail",
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

function decodeBase64(input: string): string {
  // Pub/Sub uses standard base64 (not base64url) for the data field.
  // Buffer handles both so this is safe in Node.
  return Buffer.from(input, "base64").toString("utf8");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultLogger: NonNullable<GmailPubsubReceiverConfig["logger"]> = (level, msg, ctx) => {
  const line = ctx === undefined ? msg : `${msg} ${JSON.stringify(ctx)}`;
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.error)(line);
};
