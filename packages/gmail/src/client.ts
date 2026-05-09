// Minimal Gmail REST API client for the v0.1 pull-mode connector.
// We hit three endpoints:
//   POST https://oauth2.googleapis.com/token            — exchange refresh → access
//   GET  /gmail/v1/users/me/messages?q=…                — list message IDs (cursor)
//   GET  /gmail/v1/users/me/messages/{id}?format=full   — fetch headers + body
//
// Auth is OAuth 2.0 refresh-token flow only in v0.1. The connector
// caches the access token until ~1 minute before expiry and refreshes
// transparently on the next call. Service account / domain-wide
// delegation is queued for v0.1.1 (needs JWT signing).
//
// Body extraction prefers `text/plain` MIME parts, then falls back to
// `text/html` with tags stripped. Empty bodies fall back to Gmail's
// server-side `snippet` (first ~200 chars).

import { ConnectorError } from "@statewavedev/connectors-core";
import { Buffer as NodeBuffer } from "node:buffer";
import type { GmailMessage, GmailOAuthCredentials } from "./types.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com";
const OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_PAGE_SIZE = 100;
/** Max characters of plaintext body to keep per message — long emails get
 * truncated so a single thread doesn't dominate context bundles. */
const BODY_MAX_CHARS = 8000;

export interface GmailClientOptions {
  credentials: GmailOAuthCredentials;
  /** Override the Gmail API base (sandbox / test). Takes precedence. */
  baseUrl?: string;
  /** Override the OAuth token endpoint (sandbox / test). */
  oauthTokenEndpoint?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawListResponse {
  messages?: ReadonlyArray<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface RawMessageResponse {
  id: string;
  threadId: string;
  labelIds?: ReadonlyArray<string>;
  snippet?: string;
  internalDate?: string;
  payload?: RawPayload;
}

interface RawPayload {
  mimeType?: string;
  headers?: ReadonlyArray<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: ReadonlyArray<RawPayload>;
}

interface CachedAccessToken {
  token: string;
  /** Epoch ms after which the token MUST be refreshed (a small safety
   * margin is subtracted so callers never use a token that's one
   * round-trip away from expiring). */
  expires_at_ms: number;
}

export class GmailClient {
  private readonly baseUrl: string;
  private readonly oauthTokenEndpoint: string;
  private readonly credentials: GmailOAuthCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private cached?: CachedAccessToken;

  constructor(options: GmailClientOptions) {
    if (!options.credentials?.clientId || !options.credentials.clientSecret || !options.credentials.refreshToken) {
      throw new ConnectorError(
        "gmail OAuth credentials are required (clientId, clientSecret, refreshToken)",
        {
          code: "auth_missing",
          connector: "gmail",
          hint:
            "set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN, or pass --client-id, --client-secret, --refresh-token",
        },
      );
    }
    this.credentials = options.credentials;
    this.baseUrl = options.baseUrl ?? GMAIL_API_BASE;
    this.oauthTokenEndpoint = options.oauthTokenEndpoint ?? OAUTH_TOKEN_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "statewave-connectors-gmail/0.1.0 (+https://github.com/smaramwbc/statewave-connectors)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "gmail",
      });
    }
  }

  /**
   * Auth probe — exchange refresh → access token. On success we just
   * surface the OK signal; on 400/401 the token endpoint will throw
   * with a friendly hint at the call site.
   */
  async authProbe(): Promise<void> {
    await this.getAccessToken();
  }

  /**
   * Page through `GET /messages?q=…`, fetching each message in `format=full`
   * and adopting it into the typed `GmailMessage` shape. The `query`
   * is required — operators must scope the pull (e.g. `label:inbox`,
   * `from:foo@bar.com after:2026/01/01`); ingesting an entire mailbox
   * by default would be expensive and surprising.
   *
   * Messages are returned newest-first by Gmail's API; we preserve that
   * ordering so consumers can short-circuit on `--max-items` without
   * scrolling back through years of history.
   */
  async listMessages(
    options: { query: string; maxItems?: number; labelIds?: ReadonlyArray<string> },
  ): Promise<ReadonlyArray<GmailMessage>> {
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: GmailMessage[] = [];
    let pageToken: string | undefined;

    while (out.length < cap) {
      const params = new URLSearchParams({
        q: options.query,
        maxResults: String(Math.min(DEFAULT_PAGE_SIZE, cap - out.length)),
      });
      // v0.1.1: typed --label-ids server-side filter. Gmail's REST API
      // supports repeated `labelIds` query parameters (AND semantics
      // server-side — a message must have every listed label). Useful
      // when callers want to scope by Gmail's stable label IDs (e.g.
      // INBOX, IMPORTANT, STARRED, or a user-defined Label_xyz id)
      // without encoding them into the `q` query string.
      if (options.labelIds && options.labelIds.length > 0) {
        for (const id of options.labelIds) params.append("labelIds", id);
      }
      if (pageToken) params.set("pageToken", pageToken);
      const list = await this.callJson<RawListResponse>(
        `/gmail/v1/users/me/messages?${params.toString()}`,
      );
      const refs = list.messages ?? [];
      if (refs.length === 0) break;
      for (const ref of refs) {
        if (out.length >= cap) break;
        const full = await this.callJson<RawMessageResponse>(
          `/gmail/v1/users/me/messages/${encodeURIComponent(ref.id)}?format=full`,
        );
        out.push(adoptMessage(full));
      }
      if (!list.nextPageToken) break;
      pageToken = list.nextPageToken;
    }
    return out;
  }

  // -- internals -----------------------------------------------------------

  /**
   * Exchange the refresh token for an access token. Cached with a 60s
   * safety margin so we never hand back a token that's about to expire
   * mid-request.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expires_at_ms > now + 60_000) {
      return this.cached.token;
    }
    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: "refresh_token",
    });
    const res = await this.fetchImpl(this.oauthTokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
      body: body.toString(),
    });
    if (res.status === 400 || res.status === 401) {
      throw new ConnectorError(`gmail OAuth token endpoint returned ${res.status}`, {
        code: "auth_failed",
        connector: "gmail",
        hint:
          "verify GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN. The refresh token must be issued for the same client_id and must not be revoked",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`gmail OAuth token endpoint returned HTTP ${res.status}`, {
        code: "network",
        connector: "gmail",
      });
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new ConnectorError("gmail OAuth response missing access_token", {
        code: "auth_failed",
        connector: "gmail",
      });
    }
    const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.cached = {
      token: json.access_token,
      expires_at_ms: Date.now() + expiresInSec * 1000,
    };
    return json.access_token;
  }

  private async callJson<T>(path: string): Promise<T> {
    const access = await this.getAccessToken();
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });
    if (res.status === 401) {
      // Cached token was rejected — drop the cache and surface a
      // typed error. The next sync will re-exchange the refresh token.
      this.cached = undefined;
      throw new ConnectorError(`gmail ${path} returned 401`, {
        code: "auth_failed",
        connector: "gmail",
        hint: "the access token was rejected — the refresh token may have been revoked",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`gmail ${path} returned 403`, {
        code: "permission_denied",
        connector: "gmail",
        hint:
          "the OAuth client must include the gmail.readonly scope; consent must be granted by the user the refresh token belongs to",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError(`gmail ${path} returned 404`, {
        code: "not_found",
        connector: "gmail",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`gmail ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "gmail",
        hint: "Gmail enforces per-user rate limits; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`gmail ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "gmail",
      });
    }
    return (await res.json()) as T;
  }
}

function adoptMessage(raw: RawMessageResponse): GmailMessage {
  const headers = headerMap(raw.payload?.headers);
  const internalDate = raw.internalDate ? Number.parseInt(raw.internalDate, 10) : NaN;
  const internal_date = Number.isFinite(internalDate)
    ? new Date(internalDate).toISOString()
    : new Date().toISOString();
  return {
    id: raw.id,
    thread_id: raw.threadId,
    internal_date,
    label_ids: raw.labelIds ?? [],
    snippet: raw.snippet,
    from: headers.get("from"),
    to: headers.get("to"),
    cc: headers.get("cc"),
    subject: headers.get("subject"),
    date: headers.get("date"),
    message_id_header: headers.get("message-id"),
    body: extractBody(raw.payload, raw.snippet),
  };
}

function headerMap(
  headers: ReadonlyArray<{ name: string; value: string }> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!headers) return out;
  for (const h of headers) {
    out.set(h.name.toLowerCase(), h.value);
  }
  return out;
}

/**
 * Walk the MIME tree to find a text body. Preference order:
 *   1. text/plain part
 *   2. text/html part (tags stripped)
 *   3. snippet fallback
 * Bodies over BODY_MAX_CHARS are truncated with an ellipsis marker so
 * downstream context bundles don't get dominated by a single huge
 * message.
 */
function extractBody(payload: RawPayload | undefined, snippetFallback?: string): string {
  if (!payload) return snippetFallback ?? "";
  const plainPart = findPart(payload, "text/plain");
  if (plainPart?.body?.data) {
    return truncate(decodeBase64Url(plainPart.body.data));
  }
  const htmlPart = findPart(payload, "text/html");
  if (htmlPart?.body?.data) {
    return truncate(stripHtml(decodeBase64Url(htmlPart.body.data)));
  }
  // Single-part messages put the body on the root payload.
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data);
    if (payload.mimeType === "text/html") return truncate(stripHtml(decoded));
    return truncate(decoded);
  }
  return snippetFallback ?? "";
}

function findPart(payload: RawPayload, mime: string): RawPayload | undefined {
  if (payload.mimeType === mime && payload.body?.data) return payload;
  if (!payload.parts) return undefined;
  for (const p of payload.parts) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return undefined;
}

function decodeBase64Url(data: string): string {
  // Gmail returns base64url; Node's Buffer.from with "base64" tolerates
  // url-safe input on recent versions, but normalize defensively.
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return NodeBuffer.from(normalized, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= BODY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, BODY_MAX_CHARS)}…`;
}
