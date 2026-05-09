// `createFreshdeskConnector` — pull-mode source connector for Freshdesk.
// Reads tickets (and optionally per-ticket conversations) from a single
// Freshdesk account via the REST API and emits freshdesk.* episodes on
// `customer:<company_or_requester_id>` subjects.

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
import { FreshdeskClient, type FreshdeskClientOptions } from "./client.js";
import { defaultSubject, mapFreshdeskEvent } from "./mapper.js";
import type {
  FreshdeskCompany,
  FreshdeskEvent,
  FreshdeskTicket,
  FreshdeskUser,
} from "./types.js";

export interface FreshdeskConnectorConfig {
  /** `acme` for `https://acme.freshdesk.com`. Required unless `baseUrl` is set. */
  subdomain?: string;
  /** Override the full base URL (sandbox / test). When set, takes precedence. */
  baseUrl?: string;
  /** API key (sent as the username in HTTP Basic auth, password fixed to "X"). */
  apiKey: string;
  /** Override subject. Defaults to `customer:<company_or_requester_id>` per ticket. */
  subject?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["tickets"] as const;
type FreshdeskKindGroup = "tickets" | "conversations";
const ALL_GROUPS: ReadonlyArray<FreshdeskKindGroup> = ["tickets", "conversations"];

export function createFreshdeskConnector(
  config: FreshdeskConnectorConfig,
): StatewaveConnector<FreshdeskConnectorConfig, FreshdeskEvent> {
  if (!config.subdomain && !config.baseUrl) {
    throw new ConnectorError(
      "the freshdesk connector requires a subdomain — pass --subdomain <acme> or set FRESHDESK_SUBDOMAIN",
      {
        code: "config_invalid",
        connector: "freshdesk",
        hint: "for `https://acme.freshdesk.com`, the subdomain is `acme`",
      },
    );
  }
  if (!config.apiKey) {
    throw new ConnectorError(
      "the freshdesk connector requires an apiKey",
      {
        code: "auth_missing",
        connector: "freshdesk",
        hint: "find your API key in the Freshdesk UI: profile menu → Profile settings → API Key",
      },
    );
  }

  const clientOptions: FreshdeskClientOptions = {
    subdomain: config.subdomain,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl,
  };
  const client = new FreshdeskClient(clientOptions);

  let identity: { id: number; name?: string; email?: string } | undefined;
  async function ensureIdentity(): Promise<{ id: number; name?: string; email?: string }> {
    if (identity) return identity;
    identity = await client.authMe();
    return identity;
  }

  return {
    id: `freshdesk:${config.subdomain ?? config.baseUrl}`,
    name: "Freshdesk",
    source: "freshdesk",

    async configure(_next: FreshdeskConnectorConfig): Promise<void> {
      throw new ConnectorError("freshdesk connector is configured at construction time", {
        code: "unsupported",
        connector: "freshdesk",
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
          message: me.email ? `${me.email} (${me.id})` : `agent:${me.id}`,
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
        message: config.baseUrl ?? `https://${config.subdomain}.freshdesk.com`,
      });
      return { connector: "freshdesk", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since
        ? options.since instanceof Date
          ? options.since.toISOString()
          : options.since
        : undefined;

      // Pull tickets first (both groups need them as the spine).
      const tickets = await client.listTickets({ since, maxItems: options.maxItems });

      // Best-effort requester + company enrichment. Fan out per distinct id
      // so the mapper can render names without a second API call per
      // conversation entry. Failures are silent — enrichment never blocks.
      const requesterDir = new Map<number, FreshdeskUser>();
      const companyDir = new Map<number, FreshdeskCompany>();
      const distinctRequesterIds = Array.from(
        new Set(
          tickets
            .map((t) => t.requester_id)
            .filter((id): id is number => typeof id === "number" && id > 0),
        ),
      );
      for (const id of distinctRequesterIds) {
        const contact = await client.getContact(id);
        if (contact) requesterDir.set(id, contact);
      }
      const distinctCompanyIds = Array.from(
        new Set(
          tickets
            .map((t) => t.company_id)
            .filter((id): id is number => typeof id === "number" && id > 0),
        ),
      );
      for (const id of distinctCompanyIds) {
        const company = await client.getCompany(id);
        if (company) companyDir.set(id, company);
      }

      const events: FreshdeskEvent[] = [];

      if (groups.has("tickets")) {
        for (const ticket of tickets) {
          const requester = ticket.requester_id ? requesterDir.get(ticket.requester_id) : undefined;
          const company = ticket.company_id ? companyDir.get(ticket.company_id) : undefined;
          events.push({ type: "ticket.created", ticket, requester, company });
          if (ticket.status === "resolved" || ticket.status === "closed") {
            events.push({ type: "ticket.resolved", ticket, requester, company });
          }
        }
      }

      if (groups.has("conversations")) {
        // N+1 over tickets — gated behind --include conversations because
        // the API budget can multiply quickly.
        for (const ticket of tickets) {
          if (events.length >= (options.maxItems ?? Number.POSITIVE_INFINITY)) break;
          const conversations = await client.listTicketConversations(ticket.id);
          const requester = ticket.requester_id ? requesterDir.get(ticket.requester_id) : undefined;
          const company = ticket.company_id ? companyDir.get(ticket.company_id) : undefined;
          for (const conversation of conversations) {
            events.push({ type: "conversation", ticket, conversation, requester, company });
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);
      const subdomain = config.subdomain;

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const subject =
          options.subject ?? config.subject ?? defaultSubject(ev.ticket);
        const ep = mapFreshdeskEvent(ev, { subject, subdomain });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const created = limited.filter((e) => e.type === "ticket.created").length;
      const resolved = limited.filter((e) => e.type === "ticket.resolved").length;
      const repliesPublic = limited.filter(
        (e) => e.type === "conversation" && !e.conversation.private,
      ).length;
      const repliesPrivate = limited.filter(
        (e) => e.type === "conversation" && e.conversation.private,
      ).length;
      const details: Record<string, number> = {
        tickets_synced: tickets.length,
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_ticket_created: created,
        events_ticket_resolved: resolved,
        events_conversation_public: repliesPublic,
        events_conversation_internal: repliesPrivate,
      };

      return {
        connector: "freshdesk",
        source: "freshdesk",
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

    async mapEvent(event: FreshdeskEvent): Promise<StatewaveEpisode> {
      return mapFreshdeskEvent(event, {
        subject: config.subject ?? defaultSubject(event.ticket),
        subdomain: config.subdomain,
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<FreshdeskKindGroup> {
  const base = new Set<FreshdeskKindGroup>(
    include?.length
      ? include.filter((i): i is FreshdeskKindGroup => isGroup(i))
      : (DEFAULT_INCLUDE as ReadonlyArray<FreshdeskKindGroup>),
  );
  if (exclude) for (const e of exclude) base.delete(e as FreshdeskKindGroup);
  return base;
}

function isGroup(s: string): s is FreshdeskKindGroup {
  return (ALL_GROUPS as ReadonlyArray<string>).includes(s);
}
