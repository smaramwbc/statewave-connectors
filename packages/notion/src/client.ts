// Minimal Notion REST API client for the v0.1 pull-mode connector.
// We hit two endpoints:
//   POST /v1/search                 — page enumeration (cursor pagination)
//   GET  /v1/blocks/{id}/children   — page body extraction (opt-in)
//
// Auth is just Bearer — Notion internal-integration tokens (the common
// case) and OAuth public-integration tokens both ride on the same
// `Authorization: Bearer <token>` header. The connector itself never
// runs the OAuth dance; operators with public integrations bring their
// own already-issued token.
//
// All callers see plain strings — Notion's rich-text format is flattened
// to plaintext at this boundary so the rest of the connector doesn't
// have to think about it.

import { ConnectorError } from "@statewavedev/connectors-core";
import type { NotionBlock, NotionComment, NotionPage, NotionPageParent } from "./types.js";

const NOTION_API_BASE = "https://api.notion.com";
// Pin to a long-stable Notion API version. The page + blocks read paths
// have been stable across all versions since 2022-06-28; we pin to
// avoid drift if Notion rolls a breaking default.
const NOTION_API_VERSION = "2022-06-28";

export interface NotionClientOptions {
  /** Bearer token (internal integration token or OAuth access token). */
  token: string;
  /** Override the full base URL (sandbox / test). Takes precedence. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Override the pinned API version. Operators rarely need this. */
  apiVersion?: string;
}

interface RawSearchResponse {
  object?: string;
  results: ReadonlyArray<RawPage>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface RawPage {
  object: string;
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  url?: string;
  parent?: RawParent;
  properties?: Record<string, RawProperty>;
}

interface RawParent {
  type: string;
  workspace?: boolean;
  database_id?: string;
  page_id?: string;
  block_id?: string;
}

interface RawProperty {
  type?: string;
  title?: ReadonlyArray<RawRichText>;
  rich_text?: ReadonlyArray<RawRichText>;
}

interface RawRichText {
  plain_text?: string;
  text?: { content?: string };
}

interface RawBlocksResponse {
  results: ReadonlyArray<RawBlock>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface RawCommentsResponse {
  results: ReadonlyArray<RawComment>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface RawComment {
  id: string;
  parent?: { type?: string; page_id?: string; block_id?: string };
  discussion_id?: string;
  created_time?: string;
  rich_text?: ReadonlyArray<RawRichText>;
  created_by?: { id?: string; type?: string };
}

interface RawBlock {
  id: string;
  type: string;
  has_children?: boolean;
  paragraph?: { rich_text?: ReadonlyArray<RawRichText> };
  heading_1?: { rich_text?: ReadonlyArray<RawRichText> };
  heading_2?: { rich_text?: ReadonlyArray<RawRichText> };
  heading_3?: { rich_text?: ReadonlyArray<RawRichText> };
  bulleted_list_item?: { rich_text?: ReadonlyArray<RawRichText> };
  numbered_list_item?: { rich_text?: ReadonlyArray<RawRichText> };
  to_do?: { rich_text?: ReadonlyArray<RawRichText>; checked?: boolean };
  quote?: { rich_text?: ReadonlyArray<RawRichText> };
  code?: { rich_text?: ReadonlyArray<RawRichText>; language?: string };
}

export class NotionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: NotionClientOptions) {
    if (!options.token) {
      throw new ConnectorError("notion bearer token is required", {
        code: "auth_missing",
        connector: "notion",
        hint: "set NOTION_API_TOKEN, or pass --api-token",
      });
    }
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? NOTION_API_BASE;
    this.apiVersion = options.apiVersion ?? NOTION_API_VERSION;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent =
      options.userAgent ??
      "statewave-connectors-notion/0.1.0 (+https://github.com/smaramwbc/statewave-connectors)";
    if (!this.fetchImpl) {
      throw new ConnectorError("global fetch is unavailable; pass options.fetchImpl", {
        code: "config_invalid",
        connector: "notion",
      });
    }
  }

  /**
   * Auth probe. Notion has no `/users/me` for integrations — the cheapest
   * way to verify the token is a small `search` call (limit 1, page-only).
   * On success we just return the OK signal; on 401 the request throws
   * with a friendly hint at the call site.
   */
  async authProbe(): Promise<void> {
    await this.callJson<RawSearchResponse>(`/v1/search`, {
      method: "POST",
      body: {
        page_size: 1,
        filter: { property: "object", value: "page" },
      },
    });
  }

  /**
   * Page through `POST /v1/search` filtered to pages, ordered by
   * `last_edited_time` descending. We walk forward until either
   * `has_more` is false or we hit `maxItems`. Client-side `since`
   * filter applies to `last_edited_time`.
   */
  async listPages(
    options: { since?: string; maxItems?: number } = {},
  ): Promise<ReadonlyArray<NotionPage>> {
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: NotionPage[] = [];
    let cursor: string | undefined;

    while (out.length < cap) {
      const body: Record<string, unknown> = {
        page_size: 100,
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
      };
      if (cursor) body.start_cursor = cursor;
      const page = await this.callJson<RawSearchResponse>(`/v1/search`, {
        method: "POST",
        body,
      });
      if (!Array.isArray(page.results)) {
        throw new ConnectorError("notion: search response missing results array", {
          code: "mapping_failed",
          connector: "notion",
        });
      }
      for (const raw of page.results) {
        if (raw.object !== "page") continue;
        const adopted = adoptPage(raw);
        if (sinceMs !== undefined) {
          const tsMs = new Date(adopted.last_edited_time).getTime();
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }
        out.push(adopted);
        if (out.length >= cap) break;
      }
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  /**
   * Fetch the children blocks of a page and render them to plaintext.
   * Walks the cursor for pages with more than 100 blocks. Only renders
   * the most common block types (paragraph, heading_*, list items,
   * to_do, quote, code) — other types (callouts, embeds, tables,
   * columns, child databases) are dropped.
   */
  async getPageBody(pageId: string): Promise<string> {
    const blocks = await this.listAllBlocks(pageId);
    const lines: string[] = [];
    for (const b of blocks) {
      if (b.text) lines.push(b.text);
    }
    return lines.join("\n");
  }

  /**
   * List page-level comments via `GET /v1/comments?block_id=<page_id>`.
   * Notion's comments API uses the page id as the `block_id` query
   * parameter (every page is also a block). v0.1.1 ingests page-level
   * discussion threads; per-block inline comments use the same endpoint
   * with a child block id and are queued for v0.1.2.
   *
   * Returns comments newest-first (Notion's default). The connector
   * preserves that ordering — consumers usually only care about the
   * latest activity per discussion.
   */
  /**
   * Query a single database for its rows (v0.1.2). Database rows in
   * Notion are structurally pages — same id space, same parent shape,
   * same property bag. We pull them through the same `adoptPage`
   * adapter as the search-based path so the mapper's existing
   * `parent_type: "database_id"` handling Just Works.
   *
   * The query body is intentionally minimal in v0.1.2 — no caller-
   * supplied filters or sorts. The whole database walks chronologically
   * by `last_edited_time` descending, and the operator-side `--since`
   * filter still applies via `last_edited_time` comparison at the
   * caller. Server-side property filters land in v0.1.3 alongside
   * typed property mapping.
   */
  async queryDatabasePages(
    databaseId: string,
    options: { since?: string; maxItems?: number } = {},
  ): Promise<ReadonlyArray<NotionPage>> {
    const sinceMs = options.since ? new Date(options.since).getTime() : undefined;
    const cap = options.maxItems ?? Number.POSITIVE_INFINITY;
    const out: NotionPage[] = [];
    let cursor: string | undefined;

    while (out.length < cap) {
      const body: Record<string, unknown> = {
        page_size: 100,
        sorts: [{ direction: "descending", timestamp: "last_edited_time" }],
      };
      if (cursor) body.start_cursor = cursor;
      const page = await this.callJson<RawSearchResponse>(
        `/v1/databases/${encodeURIComponent(databaseId)}/query`,
        { method: "POST", body },
      );
      if (!Array.isArray(page.results)) break;
      for (const raw of page.results) {
        if (raw.object !== "page") continue;
        const adopted = adoptPage(raw);
        if (sinceMs !== undefined) {
          const tsMs = new Date(adopted.last_edited_time).getTime();
          if (Number.isFinite(tsMs) && tsMs < sinceMs) continue;
        }
        out.push(adopted);
        if (out.length >= cap) break;
      }
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  async listPageComments(pageId: string): Promise<ReadonlyArray<NotionComment>> {
    const out: NotionComment[] = [];
    let cursor: string | undefined;
    while (true) {
      const path = cursor
        ? `/v1/comments?block_id=${encodeURIComponent(pageId)}&page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/v1/comments?block_id=${encodeURIComponent(pageId)}&page_size=100`;
      const page = await this.callJson<RawCommentsResponse>(path);
      if (!Array.isArray(page.results)) break;
      for (const raw of page.results) {
        out.push(adoptComment(raw));
      }
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  /** Public for callers who want raw blocks (e.g. custom extractors). */
  async listAllBlocks(parentId: string): Promise<ReadonlyArray<NotionBlock>> {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    while (true) {
      const path = cursor
        ? `/v1/blocks/${encodeURIComponent(parentId)}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/v1/blocks/${encodeURIComponent(parentId)}/children?page_size=100`;
      const page = await this.callJson<RawBlocksResponse>(path);
      if (!Array.isArray(page.results)) break;
      for (const raw of page.results) {
        out.push({
          id: raw.id,
          type: raw.type,
          has_children: raw.has_children,
          text: extractBlockText(raw) || undefined,
        });
      }
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return out;
  }

  // -- internals -----------------------------------------------------------

  private async callJson<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Notion-Version": this.apiVersion,
        "User-Agent": this.userAgent,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (res.status === 401) {
      throw new ConnectorError(`notion ${path} returned 401`, {
        code: "auth_failed",
        connector: "notion",
        hint:
          "verify NOTION_API_TOKEN — internal integration tokens live under Settings → Connections → Develop or manage integrations",
      });
    }
    if (res.status === 403) {
      throw new ConnectorError(`notion ${path} returned 403`, {
        code: "permission_denied",
        connector: "notion",
        hint:
          "the integration must be invited to each page or database it can read; share each parent page with the integration",
      });
    }
    if (res.status === 404) {
      throw new ConnectorError(`notion ${path} returned 404`, {
        code: "not_found",
        connector: "notion",
      });
    }
    if (res.status === 429) {
      throw new ConnectorError(`notion ${path} rate-limited (HTTP 429)`, {
        code: "rate_limited",
        connector: "notion",
        hint: "Notion enforces rate limits per integration; back off and retry",
      });
    }
    if (!res.ok) {
      throw new ConnectorError(`notion ${path} returned HTTP ${res.status}`, {
        code: "network",
        connector: "notion",
      });
    }
    return (await res.json()) as T;
  }
}

function adoptPage(raw: RawPage): NotionPage {
  const parent: NotionPageParent = adoptParent(raw.parent);
  return {
    id: raw.id,
    created_time: raw.created_time,
    last_edited_time: raw.last_edited_time,
    archived: !!raw.archived,
    parent,
    url: raw.url ?? `https://www.notion.so/${raw.id.replace(/-/g, "")}`,
    title: extractTitle(raw.properties),
  };
}

function adoptParent(p: RawParent | undefined): NotionPageParent {
  if (!p) return { type: "workspace", workspace: true };
  if (p.type === "database_id" && p.database_id) {
    return { type: "database_id", database_id: p.database_id };
  }
  if (p.type === "page_id" && p.page_id) {
    return { type: "page_id", page_id: p.page_id };
  }
  if (p.type === "block_id" && p.block_id) {
    return { type: "block_id", block_id: p.block_id };
  }
  return { type: "workspace", workspace: true };
}

/**
 * Notion stores titles under arbitrary property names depending on the
 * database schema. The convention is to find the property whose `type`
 * is `"title"` and concatenate its `title` rich-text array. For pages
 * directly under a workspace the property is always called "title", but
 * pages inside a database can have it named anything ("Name", "Subject",
 * a custom column name, …).
 */
function adoptComment(raw: RawComment): NotionComment {
  const parent = raw.parent ?? {};
  const parent_type = parent.type ?? "unknown";
  const parent_id = parent.page_id ?? parent.block_id ?? "";
  return {
    id: raw.id,
    created_time: raw.created_time ?? new Date().toISOString(),
    discussion_id: raw.discussion_id ?? "",
    parent_type,
    parent_id,
    text: joinRichText(raw.rich_text),
    author_id: raw.created_by?.id,
    author_name: undefined,
  };
}

function extractTitle(properties: Record<string, RawProperty> | undefined): string {
  if (!properties) return "";
  for (const value of Object.values(properties)) {
    if (value?.type === "title" && Array.isArray(value.title)) {
      return value.title.map((r) => r.plain_text ?? r.text?.content ?? "").join("").trim();
    }
  }
  return "";
}

function extractBlockText(b: RawBlock): string {
  switch (b.type) {
    case "paragraph":
      return joinRichText(b.paragraph?.rich_text);
    case "heading_1":
      return prefixIfPresent("# ", joinRichText(b.heading_1?.rich_text));
    case "heading_2":
      return prefixIfPresent("## ", joinRichText(b.heading_2?.rich_text));
    case "heading_3":
      return prefixIfPresent("### ", joinRichText(b.heading_3?.rich_text));
    case "bulleted_list_item":
      return prefixIfPresent("- ", joinRichText(b.bulleted_list_item?.rich_text));
    case "numbered_list_item":
      return prefixIfPresent("1. ", joinRichText(b.numbered_list_item?.rich_text));
    case "to_do": {
      const text = joinRichText(b.to_do?.rich_text);
      if (!text) return "";
      return `${b.to_do?.checked ? "[x]" : "[ ]"} ${text}`;
    }
    case "quote":
      return prefixIfPresent("> ", joinRichText(b.quote?.rich_text));
    case "code": {
      const text = joinRichText(b.code?.rich_text);
      if (!text) return "";
      const lang = b.code?.language ?? "";
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    default:
      return "";
  }
}

function joinRichText(rt: ReadonlyArray<RawRichText> | undefined): string {
  if (!rt || rt.length === 0) return "";
  return rt.map((r) => r.plain_text ?? r.text?.content ?? "").join("").trim();
}

function prefixIfPresent(prefix: string, text: string): string {
  if (!text) return "";
  return `${prefix}${text}`;
}
