// Minimal Intercom REST API client for the v0.1 pull-mode connector.
// We hit three endpoints:
//   GET /me                     — auth probe + workspace identity
//   GET /conversations          — conversation pagination (cursor)
//   GET /conversations/{id}     — full conversation_parts (replies + notes)
//
// Auth is just Bearer — Intercom personal access tokens (internal apps)
// and OAuth access tokens (public apps) both ride on the same header
// shape, so the client doesn't need a mode discriminator.
//
// All callers pass the region; the client maps it to the right edge URL
// (US / EU / AU) so EU/AU operators don't accidentally hit US infra.

import { ConnectorError } from "@statewavedev/connectors-core";
import type {
  IntercomConversation,
  IntercomConversationPart,
  IntercomConversationState,
  IntercomContact,
  IntercomRegion,
} from "./types.js";

const REGION_BASE: Record<IntercomRegion, string> = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
  au: "https://api.au.intercom.io",
};

// Pin to a recent stable Intercom API version. Reading the conversations
// surface is stable across minor versions; we pin to avoid breaking
// changes when Intercom rolls a new default.
const INTERCOM_API_VERSION = "2.13";
const DEFAULT_PAGE_SIZE = 50;

export interface IntercomClientOptions {
  accessToken: string;
  region?: IntercomRegion;
  /** Override the full base URL (sandbox / test). Takes precedence over region. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Override the pinned API version. Operators rarely need this. */
  apiVersion?: string;
}

interface RawAdminResponse {
  type: string;
  id: string;
  name?: string;
  email?: string;
  app?: { id_code?: string; name?: string };
}

interface RawConversationsResponse {
  type: string;
  conversations: ReadonlyArray<RawConversation>;
  pages?: {
    type?: string;
    next?: { starting_after?: string } | string | null;
    page?: number;
    per_page?: number;
    total_pages?: number;
  };
  total_count?: number;
}

interface RawConversation {
  id: string;
  created_at: number;
  updated_at: number;
  state: string;
  priority?: string;
  tags?: { tags?: ReadonlyArray<{ name: string }> } | null;
  source?: {
    type?: string;
    body?: string;
    subject?: string | null;
    author?: RawConversationAuthor;
  };
  contacts?: {
    contacts?: ReadonlyArray<{ id: string; type?: string }>;
  };
  admin_assignee_id?: string | null;
  team_assignee_id?: string | null;
  conversation_parts?: {
    conversation_parts?: ReadonlyArray<RawConversationPart>;
  };
}

interface RawConversationAuthor {
  type?: string;
  id?: string;
  name?: string;
  email?: string;
}

interface RawConversationPart {
  id: string;
  part_type: string;
  body?: string | null;
  created_at: number;
  author?: RawConversationAuthor;
}

interface RawContactResponse {
  id: string;
  type: string;
  name?: string | null;
  email?: string | null;
  external_id?: string | null;
  role?: string;
  companies?: {
    type?: string;
    data?: ReadonlyArray<{ id: string }>;
  };
}

interface RawCompanyResponse {
  id: string;
  name?: string;
}

export class IntercomClient {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: IntercomClientOptions) {
    if (!options.accessToken) {
      throw new ConnectorError("intercom access token is required", {
        code: "auth_missing",
        connector: "intercom",
        hint: "set INTERCOM_ACCESS_TOKEN, or pass --access-token",
      });
    }
    const region: IntercomRegion = options.region ?? "us";
    if (!options.baseUrl && !REGION_BASE[region]) {
      throw new ConnectorError(`intercom: unsupported region "${region}"`, {
        code: "config_invalid",
        connector: "intercom",
        hint: "use one of: us, eu, au",
      });
    }
    this.baseUrl = options.baseUrl ?? REGION_BASE[region];
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion ?? INTERCOM_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "statewave-connectors-intercom/0.1.0 (+https://github.com/smaramwbc/statewave-connectors)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "intercom",
      });
    }
  }

  /** Auth probe — returns the calling admin's identity. */
  async authMe(): Promise<{ id: string; name?: string; email?: string }> {
    const r = await this.callJson<RawAdminResponse>(`/me`);
    if (!r.id) {
      throw new ConnectorError("intercom /me returned no admin id", {
        code: "auth_failed",
        connector: "intercom",
      });
    }
    return { id: r.id, name: r.name, email: r.email };
  }

  /**
   * Page through `GET /conversations` using cursor pagination. Intercom
   * returns conversations newest-first by default; we walk forward until
   * `pages.next` is null or we hit `maxItems`. Client-side filters by
   * `state` and `since` (no native server-side `created_at` filter on
   * the list endpoint without a search query — the search API is the
   * right primitive for richer filtering, queued for v0.1.1).
   */
  async listConversations(
    options: {
      since?: string;
      maxItems?: number;
      state?: IntercomConversationState | "all";
    } = {},
  ): Promise<ReadonlyArray<IntercomConversation>> {
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const stateFilter = options.state && options.state !== "all" ? options.state : undefined;
    const out: IntercomConversation[] = [];

    let path: string | undefined = `/conversations?per_page=${DEFAULT_PAGE_SIZE}`;
    while (path && out.length < cap) {
      const page: RawConversationsResponse = await this.callJson<RawConversationsResponse>(path);
      // Defensive: treat a missing/invalid conversations array as a hard
      // schema error rather than silently emitting zero episodes.
      if (!Array.isArray(page.conversations)) {
        throw new ConnectorError("intercom: conversations response missing array", {
          code: "mapping_failed",
          connector: "intercom",
        });
      }
      for (const c of page.conversations) {
        if (sinceMs !== undefined) {
          const tsMs = c.updated_at * 1000;
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }
        const adopted = adoptConversation(c);
        if (stateFilter && adopted.state !== stateFilter) continue;
        out.push(adopted);
        if (out.length >= cap) break;
      }
      path = nextPath(page);
    }
    return out;
  }

  /**
   * Fetch a single conversation in full (with conversation_parts). We use
   * `display_as=plaintext` so reply bodies come back as readable text
   * instead of HTML — the rest of Statewave operates on plain prose.
   */
  async getConversationParts(
    conversationId: string,
  ): Promise<ReadonlyArray<IntercomConversationPart>> {
    const r = await this.callJson<RawConversation>(
      `/conversations/${encodeURIComponent(conversationId)}?display_as=plaintext`,
    );
    const parts = r.conversation_parts?.conversation_parts ?? [];
    return parts.map((p) => adoptPart(p));
  }

  /**
   * Resolve a contact by id and (best-effort) enrich it with the primary
   * company name. Used by the sync layer to populate `customer:<...>`
   * metadata; failures are silent so org enrichment never blocks the
   * episode stream.
   */
  async getContact(contactId: string): Promise<IntercomContact | undefined> {
    try {
      const r = await this.callJson<RawContactResponse>(
        `/contacts/${encodeURIComponent(contactId)}`,
      );
      const primaryCompanyId = r.companies?.data?.[0]?.id ?? null;
      let primaryCompanyName: string | null = null;
      if (primaryCompanyId) {
        try {
          const company = await this.callJson<RawCompanyResponse>(
            `/companies/${encodeURIComponent(primaryCompanyId)}`,
          );
          primaryCompanyName = company.name ?? null;
        } catch {
          // Company lookup is decorative — fall through with id only.
        }
      }
      return {
        id: r.id,
        name: r.name ?? null,
        email: r.email ?? null,
        external_id: r.external_id ?? null,
        role: r.role,
        primary_company_id: primaryCompanyId,
        primary_company_name: primaryCompanyName,
      };
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
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "Intercom-Version": this.apiVersion,
        "User-Agent": this.userAgent,
      },
    });

    if (res.status === 401) {
      throw new ConnectorError(`intercom ${path} returned 401`, {
        code: "auth_failed",
        connector: "intercom",
        hint: "verify INTERCOM_ACCESS_TOKEN — personal access tokens live under Settings → Workspace settings → Developers → Your apps",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`intercom ${path} returned 403`, {
        code: "permission_denied",
        connector: "intercom",
        hint: "the token must have read access to conversations + contacts in this workspace",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError(`intercom ${path} returned 404`, {
        code: "not_found",
        connector: "intercom",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`intercom ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "intercom",
        hint: "Intercom enforces per-app rate limits; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`intercom ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "intercom",
      });
    }
    return (await res.json()) as T;
  }
}

function nextPath(page: RawConversationsResponse): string | undefined {
  const next = page.pages?.next;
  if (!next) return undefined;
  // Intercom returns either an object with `starting_after` or, on older
  // versions, an absolute URL string. Support both.
  if (typeof next === "string") return next;
  if (next.starting_after) {
    return `/conversations?per_page=${DEFAULT_PAGE_SIZE}&starting_after=${encodeURIComponent(next.starting_after)}`;
  }
  return undefined;
}

function adoptConversation(raw: RawConversation): IntercomConversation {
  const author = raw.source?.author;
  const contactRef = raw.contacts?.contacts?.[0];
  const contact = contactRef
    ? { id: contactRef.id, role: contactRef.type }
    : author?.type === "user" || author?.type === "lead"
      ? {
          id: author.id ?? "",
          name: author.name ?? null,
          email: author.email ?? null,
          role: author.type,
        }
      : undefined;

  return {
    id: raw.id,
    created_at: epochToIso(raw.created_at),
    updated_at: epochToIso(raw.updated_at),
    state: normalizeState(raw.state),
    priority: raw.priority === "priority" ? "priority" : "not_priority",
    tags: raw.tags?.tags?.map((t) => t.name) ?? [],
    source_body: raw.source?.body,
    source_subject: raw.source?.subject ?? null,
    contact,
    assignee_admin_id: raw.admin_assignee_id ?? null,
    team_assignee_id: raw.team_assignee_id ?? null,
  };
}

function adoptPart(raw: RawConversationPart): IntercomConversationPart {
  return {
    id: raw.id,
    part_type: raw.part_type,
    body: raw.body ?? null,
    created_at: epochToIso(raw.created_at),
    author_type: raw.author?.type,
    author_id: raw.author?.id ?? null,
    author_name: raw.author?.name ?? null,
  };
}

function normalizeState(s: string): IntercomConversationState {
  if (s === "closed" || s === "snoozed") return s;
  return "open";
}

/** Intercom timestamps are Unix epoch seconds. Convert to ISO-8601 once
 * at the boundary so the rest of the connector speaks ISO. */
function epochToIso(seconds: number): string {
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}
