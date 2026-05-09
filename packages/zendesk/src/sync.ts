// `createZendeskConnector` — pull-mode source connector for Zendesk.
// Reads tickets (and optionally per-ticket comments) from a single
// Zendesk account via the REST API and emits zendesk.* episodes on
// `customer:<org_or_requester_id>` subjects.

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
import { ZendeskClient, type ZendeskClientOptions } from "./client.js";
import { defaultSubject, mapZendeskEvent } from "./mapper.js";
import type {
  ZendeskAuth,
  ZendeskEvent,
  ZendeskOrganization,
  ZendeskTicket,
  ZendeskUser,
} from "./types.js";

export interface ZendeskConnectorConfig {
  /** `acme` for `https://acme.zendesk.com`. Required unless `baseUrl` is set. */
  subdomain?: string;
  /** Override the full base URL (sandbox / test). When set, takes precedence. */
  baseUrl?: string;
  auth: ZendeskAuth;
  /** Override subject. Defaults to `customer:<org_or_requester_id>` per ticket. */
  subject?: string;
  /**
   * Brand allowlist. When set, the sync drops any ticket whose
   * `brand_id` is not in the list. Useful for multi-brand Zendesk
   * accounts where each brand maps to a separate Statewave tenant.
   * Filter is applied client-side after the list call returns.
   */
  brands?: ReadonlyArray<number>;
  /**
   * Status allowlist. When set, the sync drops any ticket whose
   * normalized status is not in the list. Same six values as the
   * `ZendeskTicketStatus` type — `new`, `open`, `pending`, `hold`,
   * `solved`, `closed`. Useful for "only ingest open work" or
   * "backfill only resolved tickets".
   */
  statuses?: ReadonlyArray<string>;
  /**
   * Use the Incremental Tickets Export API for cold-start (v0.1.2).
   * When `false` (the default), the connector uses the regular
   * `/api/v2/tickets.json` list endpoint until a cursor has been
   * captured. Subsequent runs that pass `cursor` always use the
   * incremental endpoint regardless of this flag.
   *
   * Operators who want every sync — including the very first one —
   * to use the incremental endpoint should set this to `true` so
   * cursor state starts accumulating from sync #1. Requires the
   * API token's user to have admin access.
   */
  useIncremental?: boolean;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["tickets"] as const;
type ZendeskKindGroup = "tickets" | "comments";
const ALL_GROUPS: ReadonlyArray<ZendeskKindGroup> = ["tickets", "comments"];

export function createZendeskConnector(
  config: ZendeskConnectorConfig,
): StatewaveConnector<ZendeskConnectorConfig, ZendeskEvent> {
  if (!config.subdomain && !config.baseUrl) {
    throw new ConnectorError(
      "the zendesk connector requires a subdomain — pass --subdomain <acme> or set ZENDESK_SUBDOMAIN",
      {
        code: "config_invalid",
        connector: "zendesk",
        hint: "for `https://acme.zendesk.com`, the subdomain is `acme`",
      },
    );
  }
  if (!config.auth) {
    throw new ConnectorError(
      "the zendesk connector requires auth (api_token or oauth)",
      {
        code: "auth_missing",
        connector: "zendesk",
        hint:
          "either set ZENDESK_API_TOKEN + ZENDESK_EMAIL (api token mode), or ZENDESK_OAUTH_TOKEN (oauth mode)",
      },
    );
  }

  const clientOptions: ZendeskClientOptions = {
    subdomain: config.subdomain,
    baseUrl: config.baseUrl,
    auth: config.auth,
    fetchImpl: config.fetchImpl,
  };
  const client = new ZendeskClient(clientOptions);

  // Cache the auth probe across check() and sync().
  let identity: ZendeskUser | undefined;
  async function ensureIdentity(): Promise<ZendeskUser> {
    if (identity) return identity;
    identity = await client.authMe();
    return identity;
  }

  return {
    id: `zendesk:${config.subdomain ?? config.baseUrl}`,
    name: "Zendesk",
    source: "zendesk",

    async configure(_next: ZendeskConnectorConfig): Promise<void> {
      throw new ConnectorError("zendesk connector is configured at construction time", {
        code: "unsupported",
        connector: "zendesk",
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
          message: me.email ? `${me.email} (${me.id})` : `user:${me.id}`,
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
        message: config.baseUrl ?? `https://${config.subdomain}.zendesk.com`,
      });
      return { connector: "zendesk", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since
        ? options.since instanceof Date
          ? options.since.toISOString()
          : options.since
        : undefined;

      // v0.1.2: when SyncOptions.cursor is set, pull deltas via the
      // Incremental Tickets Export API (cursor → only tickets that
      // changed since). Otherwise fall back to the regular list call.
      // The new cursor is surfaced on the SyncResult so callers can
      // persist it for the next run. Cold-start a delta sync by
      // running the cursor-less call first to capture the initial
      // cursor.
      let allTickets: ReadonlyArray<ZendeskTicket>;
      let nextCursor: string | undefined;
      if (options.cursor) {
        const incremental = await client.listTicketsIncremental({
          cursor: options.cursor,
          maxItems: options.maxItems,
        });
        allTickets = incremental.tickets;
        nextCursor = incremental.afterCursor;
      } else if (config.useIncremental) {
        // Operator opted into incremental mode without supplying a
        // cursor — bootstrap from the start_time derived from --since
        // when present, else from epoch (full backfill).
        const startTimeSeconds = since
          ? Math.floor(new Date(since).getTime() / 1000)
          : 0;
        const incremental = await client.listTicketsIncremental({
          startTimeSeconds,
          maxItems: options.maxItems,
        });
        allTickets = incremental.tickets;
        nextCursor = incremental.afterCursor;
      } else {
        allTickets = await client.listTickets({ since, maxItems: options.maxItems });
      }

      // Client-side brand + status allowlists. Applied after the list call
      // because the v1 tickets endpoint doesn't accept brand/status server-side
      // on every Zendesk plan tier. (The Search API push is still queued
      // alongside macros-applied as a signal kind.)
      const brandSet = config.brands && config.brands.length > 0 ? new Set(config.brands) : undefined;
      const statusSet = config.statuses && config.statuses.length > 0 ? new Set(config.statuses) : undefined;
      const tickets = allTickets.filter((t) => {
        if (brandSet && (t.brand_id == null || !brandSet.has(t.brand_id))) return false;
        if (statusSet && (t.status == null || !statusSet.has(t.status))) return false;
        return true;
      });

      // Best-effort org lookup: collect distinct org ids and fetch names so
      // metadata carries a friendly label. Failures here are silent — org
      // enrichment is decorative.
      const orgIds = Array.from(
        new Set(
          tickets
            .map((t) => t.organization_id)
            .filter((id): id is number => typeof id === "number" && id > 0),
        ),
      );
      const orgs = await client.showOrganizations(orgIds);
      const orgById = new Map<number, ZendeskOrganization>(orgs.map((o) => [o.id, o]));

      const events: ZendeskEvent[] = [];

      if (groups.has("tickets")) {
        for (const ticket of tickets) {
          const organization = ticket.organization_id ? orgById.get(ticket.organization_id) : undefined;
          events.push({ type: "ticket.created", ticket, organization });
          if (ticket.status === "solved" || ticket.status === "closed") {
            events.push({ type: "ticket.solved", ticket, organization });
          }
        }
      }

      if (groups.has("comments")) {
        // N+1 over tickets — gated behind --include comments because the
        // API budget can multiply quickly. We still respect maxItems by
        // checking the running total after each ticket.
        for (const ticket of tickets) {
          if (events.length >= (options.maxItems ?? Number.POSITIVE_INFINITY)) break;
          const comments = await client.listTicketComments(ticket.id);
          const organization = ticket.organization_id ? orgById.get(ticket.organization_id) : undefined;
          for (const comment of comments) {
            events.push({ type: "comment", ticket, comment, organization });
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);
      const subdomain = config.subdomain;

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const subject =
          options.subject ?? config.subject ?? defaultSubject(ev.ticket);
        const ep = mapZendeskEvent(ev, { subject, subdomain });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const ticketCreated = limited.filter((e) => e.type === "ticket.created").length;
      const ticketSolved = limited.filter((e) => e.type === "ticket.solved").length;
      const commentsPublic = limited.filter((e) => e.type === "comment" && e.comment.public).length;
      const commentsInternal = limited.filter((e) => e.type === "comment" && !e.comment.public).length;
      const details: Record<string, number> = {
        tickets_synced: tickets.length,
        tickets_filtered_out: allTickets.length - tickets.length,
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_ticket_created: ticketCreated,
        events_ticket_solved: ticketSolved,
        events_comment_public: commentsPublic,
        events_comment_internal: commentsInternal,
      };

      return {
        connector: "zendesk",
        source: "zendesk",
        subject: options.subject ?? config.subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
        // v0.1.2: surface the next incremental cursor when the sync
        // walked the incremental endpoint. Callers persist this and
        // pass it back as `--cursor` on the next run for delta sync.
        ...(nextCursor ? { cursor: nextCursor } : {}),
      };
    },

    async mapEvent(event: ZendeskEvent): Promise<StatewaveEpisode> {
      return mapZendeskEvent(event, {
        subject: config.subject ?? defaultSubject(event.ticket),
        subdomain: config.subdomain,
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<ZendeskKindGroup> {
  const base = new Set<ZendeskKindGroup>(
    include?.length
      ? (include.filter((i): i is ZendeskKindGroup => isGroup(i)))
      : (DEFAULT_INCLUDE as ReadonlyArray<ZendeskKindGroup>),
  );
  if (exclude) for (const e of exclude) base.delete(e as ZendeskKindGroup);
  return base;
}

function isGroup(s: string): s is ZendeskKindGroup {
  return (ALL_GROUPS as ReadonlyArray<string>).includes(s);
}
