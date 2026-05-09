// `createGmailConnector` — pull-mode source connector for Gmail.
// Reads messages matching an operator-supplied Gmail search query
// (`label:inbox`, `from:foo@bar after:2026/01/01`, …) via the Gmail
// REST API and emits gmail.message.received / gmail.message.sent
// episodes scoped to `relationship:<other_email>`.

import {
  ConnectorError,
  redactEpisodeText,
  summarizeEpisodes,
  type ConnectorCheckResult,
  type StatewaveConnector,
  type StatewaveEpisode,
  type SyncOptions,
  type SyncResult,
} from "@statewavedev/connectors-core";
import { GmailClient, type GmailClientOptions } from "./client.js";
import { classifyMessage, defaultSubject, mapGmailEvent } from "./mapper.js";
import type { GmailEvent, GmailOAuthCredentials } from "./types.js";

export interface GmailConnectorConfig {
  credentials: GmailOAuthCredentials;
  /**
   * Gmail search query — required. The connector deliberately has no
   * default to avoid surprise full-mailbox scans. Examples:
   *   "label:inbox"
   *   "from:foo@bar.com after:2026/01/01"
   *   "label:work newer_than:30d"
   */
  query: string;
  /**
   * Optional label-id allowlist (v0.1.1). Pushed to Gmail's
   * `labelIds=<id>&labelIds=<id>` server-side filter (AND semantics —
   * a message must have every listed label). Use Gmail's stable label
   * ids (e.g. INBOX, IMPORTANT, STARRED, or user-defined Label_xyz)
   * when you want a typed filter rather than encoding label names
   * into `query`.
   */
  labelIds?: ReadonlyArray<string>;
  /** Override subject. Defaults to `relationship:<other_email>` per message. */
  subject?: string;
  /** Override the Gmail API base URL (sandbox / test). */
  baseUrl?: string;
  /** Override the OAuth token endpoint (sandbox / test). */
  oauthTokenEndpoint?: string;
  fetchImpl?: typeof fetch;
}

export function createGmailConnector(
  config: GmailConnectorConfig,
): StatewaveConnector<GmailConnectorConfig, GmailEvent> {
  if (!config.query || config.query.trim().length === 0) {
    throw new ConnectorError(
      "the gmail connector requires a query — pass --query <gmail-search>",
      {
        code: "config_invalid",
        connector: "gmail",
        hint:
          "examples: --query 'label:inbox', --query 'from:foo@bar.com after:2026/01/01'. Ingesting an entire mailbox by default would be expensive and surprising.",
      },
    );
  }
  if (!config.credentials) {
    throw new ConnectorError(
      "the gmail connector requires OAuth credentials (clientId, clientSecret, refreshToken)",
      {
        code: "auth_missing",
        connector: "gmail",
      },
    );
  }

  const clientOptions: GmailClientOptions = {
    credentials: config.credentials,
    baseUrl: config.baseUrl,
    oauthTokenEndpoint: config.oauthTokenEndpoint,
    fetchImpl: config.fetchImpl,
  };
  const client = new GmailClient(clientOptions);

  return {
    id: `gmail`,
    name: "Gmail",
    source: "gmail",

    async configure(_next: GmailConnectorConfig): Promise<void> {
      throw new ConnectorError("gmail connector is configured at construction time", {
        code: "unsupported",
        connector: "gmail",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{ name: string; status: "ok" | "warn" | "error"; message?: string }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        await client.authProbe();
        details.push({ name: "auth", status: "ok", message: "OAuth refresh exchange succeeded" });
      } catch (err) {
        status = "error";
        details.push({
          name: "auth",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      details.push({ name: "query", status: "ok", message: config.query });
      return { connector: "gmail", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();

      const messages = await client.listMessages({
        query: config.query,
        maxItems: options.maxItems,
        ...(config.labelIds && config.labelIds.length > 0 ? { labelIds: config.labelIds } : {}),
      });

      // Optional client-side `since` filter on internalDate. Gmail's
      // search syntax already supports `after:YYYY/MM/DD`; this is a
      // belt-and-suspenders pass for callers who pass --since at the
      // CLI without re-encoding it into the Gmail query.
      const sinceMs = options.since
        ? new Date(options.since instanceof Date ? options.since.toISOString() : options.since).getTime()
        : undefined;
      const filtered = sinceMs !== undefined
        ? messages.filter((m) => new Date(m.internal_date).getTime() >= sinceMs)
        : messages;

      const events: GmailEvent[] = filtered.map(classifyMessage);

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const subject =
          options.subject ?? config.subject ?? defaultSubject(ev.message, ev.type === "message.sent");
        const ep = mapGmailEvent(ev, { subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const received = limited.filter((e) => e.type === "message.received").length;
      const sent = limited.filter((e) => e.type === "message.sent").length;
      const details: Record<string, number> = {
        messages_synced: messages.length,
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_message_received: received,
        events_message_sent: sent,
      };

      return {
        connector: "gmail",
        source: "gmail",
        subject: options.subject ?? config.subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: GmailEvent): Promise<StatewaveEpisode> {
      return mapGmailEvent(event, {
        subject:
          config.subject ?? defaultSubject(event.message, event.type === "message.sent"),
      });
    },
  };
}
