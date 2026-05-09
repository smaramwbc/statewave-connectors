// `createIntercomConnector` — pull-mode source connector for Intercom.
// Reads conversations (and optionally per-conversation parts) from a single
// Intercom workspace via the REST API and emits intercom.* episodes on
// `customer:<company_or_contact_id>` subjects.

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
import { IntercomClient, type IntercomClientOptions } from "./client.js";
import { defaultSubject, mapIntercomEvent } from "./mapper.js";
import type {
  IntercomContact,
  IntercomConversation,
  IntercomEvent,
  IntercomRegion,
} from "./types.js";

export interface IntercomConnectorConfig {
  /** Bearer token (personal access token or OAuth access token). */
  accessToken: string;
  region?: IntercomRegion;
  /** Override the full base URL (sandbox / test). Takes precedence over region. */
  baseUrl?: string;
  /** Workspace id ("app id") — used to mint browser permalinks on each
   * episode. Optional: omitted permalinks just leave `source.url` empty. */
  appId?: string;
  /** Override subject. Defaults to `customer:<company_or_contact_id>` per conversation. */
  subject?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["conversations"] as const;
type IntercomKindGroup = "conversations" | "parts";
const ALL_GROUPS: ReadonlyArray<IntercomKindGroup> = ["conversations", "parts"];

export function createIntercomConnector(
  config: IntercomConnectorConfig,
): StatewaveConnector<IntercomConnectorConfig, IntercomEvent> {
  if (!config.accessToken) {
    throw new ConnectorError(
      "the intercom connector requires an accessToken — pass --access-token or set INTERCOM_ACCESS_TOKEN",
      {
        code: "auth_missing",
        connector: "intercom",
        hint:
          "create a personal access token at Settings → Workspace settings → Developers → Your apps; or pass an OAuth access token from a public app",
      },
    );
  }

  const clientOptions: IntercomClientOptions = {
    accessToken: config.accessToken,
    region: config.region,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  };
  const client = new IntercomClient(clientOptions);

  let identity: { id: string; name?: string; email?: string } | undefined;
  async function ensureIdentity(): Promise<{ id: string; name?: string; email?: string }> {
    if (identity) return identity;
    identity = await client.authMe();
    return identity;
  }

  return {
    id: `intercom:${config.appId ?? config.region ?? "us"}`,
    name: "Intercom",
    source: "intercom",

    async configure(_next: IntercomConnectorConfig): Promise<void> {
      throw new ConnectorError("intercom connector is configured at construction time", {
        code: "unsupported",
        connector: "intercom",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{ name: string; status: "ok" | "warn" | "error"; message?: string }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        const me = await ensureIdentity();
        details.push({
          name: "auth",
          status: "ok",
          message: me.email ? `${me.email} (${me.id})` : `admin:${me.id}`,
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "auth",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      details.push({
        name: "host",
        status: "ok",
        message: config.baseUrl ?? `intercom region: ${config.region ?? "us"}`,
      });
      return { connector: "intercom", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since
        ? options.since instanceof Date
          ? options.since.toISOString()
          : options.since
        : undefined;

      // Pull conversations first (both groups need them as the spine).
      const conversations = await client.listConversations({
        since,
        maxItems: options.maxItems,
      });

      // Best-effort contact + primary-company enrichment. We resolve each
      // distinct contact once so the mapper can render names + route on
      // company id without paying N API calls per conversation.
      const contactDirectory = new Map<string, IntercomContact>();
      const distinctContactIds = Array.from(
        new Set(
          conversations
            .map((c) => c.contact?.id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      );
      for (const id of distinctContactIds) {
        const contact = await client.getContact(id);
        if (contact) contactDirectory.set(id, contact);
      }

      const events: IntercomEvent[] = [];

      if (groups.has("conversations")) {
        for (const conversation of conversations) {
          events.push({ type: "conversation.created", conversation });
          if (conversation.state === "closed") {
            events.push({ type: "conversation.closed", conversation });
          }
        }
      }

      if (groups.has("parts")) {
        // N+1 over conversations — gated behind --include parts because
        // the API budget can multiply quickly. Respect maxItems by
        // checking the running total after each conversation.
        for (const conversation of conversations) {
          if (events.length >= (options.maxItems ?? Number.POSITIVE_INFINITY)) break;
          const parts = await client.getConversationParts(conversation.id);
          for (const part of parts) {
            // Skip system parts (assignment, close, snooze, away_mode, …).
            // v0.1 only emits episodes for content the agent or contact
            // actually wrote — comments and admin notes.
            if (part.part_type !== "comment" && part.part_type !== "note") continue;
            // Drop empty bodies — Intercom emits "open" / "close" parts
            // with body=null, and the mapper would render a blank message.
            if (!part.body || part.body.trim() === "") continue;
            events.push({ type: "conversation.part", conversation, part });
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);
      const region = config.region ?? "us";
      const appId = config.appId;

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const subject =
          options.subject ?? config.subject ?? defaultSubject(ev.conversation, contactDirectory);
        const ep = mapIntercomEvent(ev, { subject, appId, region, contactDirectory });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const created = limited.filter((e) => e.type === "conversation.created").length;
      const closed = limited.filter((e) => e.type === "conversation.closed").length;
      const replies = limited.filter(
        (e) => e.type === "conversation.part" && e.part.part_type === "comment",
      ).length;
      const notes = limited.filter(
        (e) => e.type === "conversation.part" && e.part.part_type === "note",
      ).length;
      const details: Record<string, number> = {
        conversations_synced: conversations.length,
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_conversation_created: created,
        events_conversation_closed: closed,
        events_reply: replies,
        events_note: notes,
      };

      return {
        connector: "intercom",
        source: "intercom",
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

    async mapEvent(event: IntercomEvent): Promise<StatewaveEpisode> {
      return mapIntercomEvent(event, {
        subject: config.subject ?? defaultSubject(event.conversation),
        appId: config.appId,
        region: config.region ?? "us",
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<IntercomKindGroup> {
  const base = new Set<IntercomKindGroup>(
    include?.length
      ? include.filter((i): i is IntercomKindGroup => isGroup(i))
      : (DEFAULT_INCLUDE as ReadonlyArray<IntercomKindGroup>),
  );
  if (exclude) for (const e of exclude) base.delete(e as IntercomKindGroup);
  return base;
}

function isGroup(s: string): s is IntercomKindGroup {
  return (ALL_GROUPS as ReadonlyArray<string>).includes(s);
}
