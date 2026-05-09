// Minimal Freshdesk REST API client for the v0.1 pull-mode connector.
// We hit four endpoints:
//   GET /api/v2/agents/me                     — auth probe
//   GET /api/v2/tickets                       — ticket pagination (offset)
//   GET /api/v2/tickets/{id}/conversations    — replies + agent notes
//   GET /api/v2/companies/{id}                — best-effort org enrichment
//
// Auth is API key via Basic auth — Freshdesk's quirk is that the
// password literally is "X", with the API key in the username slot.
// There's no OAuth flow that meaningfully helps a server-side
// connector, so v0.1 supports just this one mode.

import { ConnectorError } from "@statewavedev/connectors-core";
import {
  FRESHDESK_STATUS_BY_CODE,
  type FreshdeskCompany,
  type FreshdeskConversation,
  type FreshdeskTicket,
  type FreshdeskTicketStatus,
  type FreshdeskUser,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 100;

export interface FreshdeskClientOptions {
  /** `acme` for `https://acme.freshdesk.com`. Required unless `baseUrl` is set. */
  subdomain?: string;
  /** Override the full base URL (sandbox / test). When set, takes precedence. */
  baseUrl?: string;
  /** API key. Sent as the username in HTTP Basic auth, with the password
   * literally fixed to "X" (Freshdesk's documented convention). */
  apiKey: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RawAgentMeResponse {
  id: number;
  contact?: {
    name?: string;
    email?: string;
  };
}

interface RawTicket {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  status?: number;
  priority?: number | null;
  type?: string | null;
  tags?: ReadonlyArray<string>;
  requester_id?: number | null;
  responder_id?: number | null;
  company_id?: number | null;
  group_id?: number | null;
  product_id?: number | null;
  created_at: string;
  updated_at: string;
}

interface RawConversation {
  id: number;
  ticket_id?: number;
  private: boolean;
  body_text?: string | null;
  user_id?: number | null;
  incoming?: boolean;
  source?: number | null;
  created_at: string;
}

interface RawContact {
  id: number;
  name?: string | null;
  email?: string | null;
  company_id?: number | null;
}

interface RawCompany {
  id: number;
  name?: string | null;
}

export class FreshdeskClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: FreshdeskClientOptions) {
    if (!options.baseUrl && !options.subdomain) {
      throw new ConnectorError(
        "the freshdesk connector requires a subdomain or baseUrl",
        {
          code: "config_invalid",
          connector: "freshdesk",
          hint: "for `https://acme.freshdesk.com`, the subdomain is `acme`",
        },
      );
    }
    if (!options.apiKey) {
      throw new ConnectorError("freshdesk apiKey is required", {
        code: "auth_missing",
        connector: "freshdesk",
        hint:
          "find your API key in the Freshdesk UI: profile menu → Profile settings → API Key (right rail)",
      });
    }
    this.baseUrl = options.baseUrl ?? `https://${options.subdomain}.freshdesk.com`;
    // Freshdesk Basic auth: <api_key>:X — the literal "X" tells Freshdesk
    // the credential pair is an API key rather than a real password.
    const encoded = Buffer.from(`${options.apiKey}:X`, "utf8").toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "statewave-connectors-freshdesk/0.1.0 (+https://github.com/smaramwbc/statewave-connectors)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "freshdesk",
      });
    }
  }

  /** Verify auth + return the calling agent's identity. */
  async authMe(): Promise<{ id: number; name?: string; email?: string }> {
    const r = await this.callJson<RawAgentMeResponse>(`/api/v2/agents/me`);
    if (!r.id) {
      throw new ConnectorError("freshdesk /agents/me returned no id", {
        code: "auth_failed",
        connector: "freshdesk",
      });
    }
    return { id: r.id, name: r.contact?.name, email: r.contact?.email };
  }

  /**
   * Page through `GET /api/v2/tickets`. Freshdesk uses page-number
   * pagination capped at 300 pages.
   *
   * v0.1.1 promotes `since` to a server-side filter via Freshdesk's
   * native `updated_since` query parameter (ISO-8601). This drops the
   * server-side load to "tickets that actually changed" rather than
   * paginating the whole list and dropping older entries client-side.
   * If the server-side filter is unavailable on the operator's plan
   * tier, the client-side check below acts as a belt-and-suspenders
   * safety net that produces the same result.
   *
   * Tickets sort newest-first by default. We walk forward until either
   * the page comes back short or we hit `maxItems`.
   */
  async listTickets(
    options: { since?: string; maxItems?: number } = {},
  ): Promise<ReadonlyArray<FreshdeskTicket>> {
    const sinceIso = options.since ? new Date(options.since).toISOString() : undefined;
    const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: FreshdeskTicket[] = [];
    let page = 1;

    while (out.length < cap) {
      const params = new URLSearchParams({
        per_page: String(DEFAULT_PAGE_SIZE),
        page: String(page),
        order_by: "created_at",
        order_type: "asc",
      });
      if (sinceIso) params.set("updated_since", sinceIso);
      const path = `/api/v2/tickets?${params.toString()}`;
      const tickets = await this.callJson<ReadonlyArray<RawTicket>>(path);
      if (!Array.isArray(tickets)) {
        throw new ConnectorError("freshdesk: tickets response was not an array", {
          code: "mapping_failed",
          connector: "freshdesk",
        });
      }
      if (tickets.length === 0) break;
      for (const t of tickets) {
        if (sinceMs !== undefined) {
          const tsMs = new Date(t.updated_at).getTime();
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }
        out.push(adoptTicket(t));
        if (out.length >= cap) break;
      }
      // Freshdesk caps page-number pagination at 300 pages. We also stop
      // early if the API returned fewer than per_page tickets (signals
      // the end of the result set).
      if (tickets.length < DEFAULT_PAGE_SIZE || page >= 300) break;
      page += 1;
    }
    return out;
  }

  /**
   * Fetch all conversations (replies + notes) for a single ticket. This
   * is paginated separately from tickets and is the source of N+1 API
   * calls — gated behind `--include conversations` at the sync layer.
   */
  async listTicketConversations(
    ticketId: number,
  ): Promise<ReadonlyArray<FreshdeskConversation>> {
    const out: FreshdeskConversation[] = [];
    let page = 1;
    while (true) {
      const path = `/api/v2/tickets/${encodeURIComponent(String(ticketId))}/conversations?per_page=${DEFAULT_PAGE_SIZE}&page=${page}`;
      const conversations = await this.callJson<ReadonlyArray<RawConversation>>(path);
      if (!Array.isArray(conversations) || conversations.length === 0) break;
      for (const c of conversations) {
        out.push({
          id: c.id,
          ticket_id: ticketId,
          private: !!c.private,
          body_text: c.body_text ?? null,
          user_id: c.user_id ?? null,
          incoming: c.incoming,
          source: c.source ?? null,
          created_at: c.created_at,
        });
      }
      if (conversations.length < DEFAULT_PAGE_SIZE) break;
      page += 1;
    }
    return out;
  }

  /**
   * Resolve a contact by id. Used by the sync layer for requester
   * enrichment so episodes carry a friendly name + email instead of
   * just a numeric id. Failures are silent — enrichment never blocks.
   */
  async getContact(contactId: number): Promise<FreshdeskUser | undefined> {
    try {
      const r = await this.callJson<RawContact>(
        `/api/v2/contacts/${encodeURIComponent(String(contactId))}`,
      );
      return {
        id: r.id,
        name: r.name ?? null,
        email: r.email ?? null,
        company_id: r.company_id ?? null,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a single company by id. Same role as Zendesk's bulk
   * organization lookup — Freshdesk doesn't ship a bulk endpoint, so
   * we fan out per id at the sync layer.
   */
  async getCompany(companyId: number): Promise<FreshdeskCompany | undefined> {
    try {
      const r = await this.callJson<RawCompany>(
        `/api/v2/companies/${encodeURIComponent(String(companyId))}`,
      );
      return { id: r.id, name: r.name ?? null };
    } catch {
      return undefined;
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
      throw new ConnectorError(`freshdesk ${path} returned 401`, {
        code: "auth_failed",
        connector: "freshdesk",
        hint: "verify the API key (profile menu → Profile settings → API Key)",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`freshdesk ${path} returned 403`, {
        code: "permission_denied",
        connector: "freshdesk",
        hint: "the agent backing this API key must have read access to tickets",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError(`freshdesk ${path} returned 404`, {
        code: "not_found",
        connector: "freshdesk",
        hint: "double-check the subdomain — `https://<subdomain>.freshdesk.com` must resolve",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`freshdesk ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "freshdesk",
        hint: "Freshdesk enforces per-plan rate limits; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`freshdesk ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "freshdesk",
      });
    }
    return (await res.json()) as T;
  }
}

function adoptTicket(t: RawTicket): FreshdeskTicket {
  const status = normalizeStatus(t.status);
  return {
    id: t.id,
    subject: t.subject ?? null,
    description_text: t.description_text ?? null,
    status,
    status_code: typeof t.status === "number" ? t.status : undefined,
    priority: t.priority ?? null,
    type: t.type ?? null,
    tags: t.tags ?? [],
    requester_id: t.requester_id ?? null,
    responder_id: t.responder_id ?? null,
    company_id: t.company_id ?? null,
    group_id: t.group_id ?? null,
    product_id: t.product_id ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

function normalizeStatus(code: number | undefined): FreshdeskTicketStatus | undefined {
  if (typeof code !== "number") return undefined;
  return FRESHDESK_STATUS_BY_CODE[code] ?? "custom";
}
