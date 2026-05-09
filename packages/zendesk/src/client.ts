// Minimal Zendesk REST API client for the v0.1 pull-mode connector.
// We hit four endpoints:
//   GET /api/v2/users/me.json                           — auth probe
//   GET /api/v2/tickets.json                            — ticket pagination
//   GET /api/v2/tickets/{id}/comments.json              — comments per ticket
//   GET /api/v2/organizations/show_many.json?ids=...    — bulk org lookup
//
// Auth supports both API token (Basic auth, the most common Zendesk pattern)
// and OAuth bearer token (for operators who already have an access token
// from a Zendesk app). Both share the same REST surface — only the header
// differs — so the rest of the connector stays mode-agnostic.

import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  ZendeskAuth,
  ZendeskComment,
  ZendeskOrganization,
  ZendeskTicket,
  ZendeskUser,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;

export interface ZendeskClientOptions {
  /** `acme` for `https://acme.zendesk.com`. Required unless `baseUrl` is set. */
  subdomain?: string;
  /** Override the full base URL (useful for sandbox / test). When set, takes
   * precedence over `subdomain`. */
  baseUrl?: string;
  auth: ZendeskAuth;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawUserResponse {
  user: {
    id: number;
    name?: string;
    email?: string;
    organization_id?: number | null;
  };
}

interface RawTicketsResponse {
  tickets: ReadonlyArray<RawTicket>;
  meta?: { has_more?: boolean; after_cursor?: string };
  links?: { next?: string };
}

interface RawTicket {
  id: number;
  subject?: string;
  description?: string;
  status?: string;
  priority?: string | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number;
  assignee_id?: number | null;
  organization_id?: number | null;
  brand_id?: number | null;
  group_id?: number | null;
  created_at: string;
  updated_at: string;
  url?: string;
}

interface RawCommentsResponse {
  comments: ReadonlyArray<RawComment>;
  meta?: { has_more?: boolean; after_cursor?: string };
  links?: { next?: string };
}

interface RawComment {
  id: number;
  public: boolean;
  body?: string;
  author_id?: number | null;
  created_at: string;
  via?: { channel?: string };
}

interface RawOrganizationsResponse {
  organizations: ReadonlyArray<{ id: number; name?: string }>;
}

export class ZendeskClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: ZendeskClientOptions) {
    if (!options.baseUrl && !options.subdomain) {
      throw new ConnectorError(
        "the zendesk connector requires a subdomain or baseUrl",
        {
          code: "config_invalid",
          connector: "zendesk",
          hint: "pass `--subdomain acme` for `https://acme.zendesk.com`, or set ZENDESK_SUBDOMAIN",
        },
      );
    }
    this.baseUrl = options.baseUrl ?? `https://${options.subdomain}.zendesk.com`;
    this.authHeader = buildAuthHeader(options.auth);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "statewave-connectors-zendesk/0.1.0 (+https://github.com/smaramwbc/statewave-connectors)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "zendesk",
      });
    }
  }

  /** Verify auth + return the calling user's identity. */
  async authMe(): Promise<ZendeskUser> {
    const r = await this.callJson<RawUserResponse>(`/api/v2/users/me.json`);
    if (!r.user?.id) {
      throw new ConnectorError("zendesk /users/me returned no user", {
        code: "auth_failed",
        connector: "zendesk",
      });
    }
    return {
      id: r.user.id,
      name: r.user.name,
      email: r.user.email,
      organization_id: r.user.organization_id ?? null,
    };
  }

  /**
   * Page through `GET /tickets.json` using cursor-based pagination
   * (`page[after]`). The `since` filter is applied client-side because the
   * non-incremental tickets endpoint doesn't accept a server-side
   * `created_at` cursor; for high-volume tenants the incremental export
   * API is the right primitive — that lands in v0.1.1.
   *
   * Tickets are returned in chronological order (oldest first) so callers
   * see them as a stable timeline.
   */
  async listTickets(
    options: { since?: string; maxItems?: number } = {},
  ): Promise<ReadonlyArray<ZendeskTicket>> {
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: ZendeskTicket[] = [];
    let path: string | undefined =
      `/api/v2/tickets.json?page[size]=${DEFAULT_PAGE_SIZE}&sort_by=created_at&sort_order=asc`;

    while (path && out.length < cap) {
      const page: RawTicketsResponse = await this.callJson<RawTicketsResponse>(path);
      for (const t of page.tickets) {
        if (sinceMs !== undefined) {
          const tsMs = new Date(t.updated_at).getTime();
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }
        out.push(adoptTicket(t));
        if (out.length >= cap) break;
      }
      path = nextPath(page);
    }
    return out;
  }

  /**
   * Fetch all comments for a single ticket. Comments are always paginated
   * separately from tickets — this is N+1 by Zendesk's API design.
   */
  async listTicketComments(ticketId: number): Promise<ReadonlyArray<ZendeskComment>> {
    const out: ZendeskComment[] = [];
    let path: string | undefined =
      `/api/v2/tickets/${encodeURIComponent(String(ticketId))}/comments.json?page[size]=${DEFAULT_PAGE_SIZE}`;

    while (path) {
      const page: RawCommentsResponse = await this.callJson<RawCommentsResponse>(path);
      for (const c of page.comments) {
        out.push({
          id: c.id,
          ticket_id: ticketId,
          public: c.public,
          body: c.body,
          author_id: c.author_id ?? null,
          created_at: c.created_at,
          via: c.via,
        });
      }
      path = nextPath(page);
    }
    return out;
  }

  /**
   * Resolve a batch of organization IDs to `{id, name}` records. We only
   * need the friendly name to render `customer:<org_id>` subjects with a
   * human-readable label in metadata — so this is best-effort: missing
   * orgs are dropped silently rather than failing the whole sync.
   */
  async showOrganizations(
    ids: ReadonlyArray<number>,
  ): Promise<ReadonlyArray<ZendeskOrganization>> {
    if (ids.length === 0) return [];
    const unique = Array.from(new Set(ids));
    const path = `/api/v2/organizations/show_many.json?ids=${encodeURIComponent(unique.join(","))}`;
    try {
      const r = await this.callJson<RawOrganizationsResponse>(path);
      return r.organizations.map((o) => ({ id: o.id, name: o.name }));
    } catch {
      // Org enrichment is decorative — never block ingestion on it.
      return [];
    }
  }

  // -- internals -----------------------------------------------------------

  private async callJson<T>(path: string): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        "User-Agent": this.userAgent,
      },
    });

    if (res.status === 401) {
      throw new ConnectorError(`zendesk ${path} returned 401`, {
        code: "auth_failed",
        connector: "zendesk",
        hint: "verify the API token (or OAuth access token) and the email it's paired with",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`zendesk ${path} returned 403`, {
        code: "permission_denied",
        connector: "zendesk",
        hint: "the user backing this token must have permission to read tickets in this account",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError(`zendesk ${path} returned 404`, {
        code: "not_found",
        connector: "zendesk",
        hint: "double-check the subdomain — `https://<subdomain>.zendesk.com` must resolve",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`zendesk ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "zendesk",
        hint: "Zendesk enforces per-account rate limits; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`zendesk ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "zendesk",
      });
    }
    return (await res.json()) as T;
  }
}

function buildAuthHeader(auth: ZendeskAuth): string {
  if (auth.mode === "oauth") {
    if (!auth.accessToken) {
      throw new ConnectorError("zendesk oauth mode requires accessToken", {
        code: "auth_missing",
        connector: "zendesk",
      });
    }
    return `Bearer ${auth.accessToken}`;
  }
  if (!auth.email || !auth.apiToken) {
    throw new ConnectorError("zendesk api_token mode requires both email and apiToken", {
      code: "auth_missing",
      connector: "zendesk",
      hint: "set ZENDESK_EMAIL + ZENDESK_API_TOKEN, or pass --email and --api-token",
    });
  }
  // Zendesk's quirk: API tokens authenticate as `<email>/token:<api_token>`,
  // not `<email>:<api_token>`. The literal `/token` segment is what tells
  // Zendesk to treat the password as an API token rather than a real password.
  const credentials = `${auth.email}/token:${auth.apiToken}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Pull the next-page path out of a Zendesk paginated response. New API
 * versions report this in `links.next` (an absolute URL) and `meta`; the
 * older style used a numeric `page` query. We support the link form (which
 * is what `page[size]=` cursor pagination returns) and stop otherwise.
 */
function nextPath(
  page: { meta?: { has_more?: boolean }; links?: { next?: string } },
): string | undefined {
  if (page.meta?.has_more === false) return undefined;
  if (page.links?.next) return page.links.next;
  return undefined;
}

function adoptTicket(t: RawTicket): ZendeskTicket {
  return {
    id: t.id,
    subject: t.subject,
    description: t.description,
    status: normalizeStatus(t.status),
    priority: t.priority ?? null,
    type: t.type ?? null,
    tags: t.tags,
    requester_id: t.requester_id,
    assignee_id: t.assignee_id ?? null,
    organization_id: t.organization_id ?? null,
    brand_id: t.brand_id ?? null,
    group_id: t.group_id ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    url: t.url,
  };
}

function normalizeStatus(s: string | undefined): ZendeskTicket["status"] {
  if (!s) return undefined;
  const lc = s.toLowerCase();
  if (
    lc === "new" ||
    lc === "open" ||
    lc === "pending" ||
    lc === "hold" ||
    lc === "solved" ||
    lc === "closed"
  ) {
    return lc;
  }
  return undefined;
}
