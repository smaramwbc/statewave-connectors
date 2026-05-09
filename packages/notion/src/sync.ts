// `createNotionConnector` — pull-mode source connector for Notion.
// Reads pages (and optionally their body content) from a Notion
// integration's accessible workspace and emits notion.* episodes.

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
import { NotionClient, type NotionClientOptions } from "./client.js";
import { classifyPage, defaultSubject, mapNotionEvent } from "./mapper.js";
import type { NotionEvent, NotionPage } from "./types.js";

export interface NotionConnectorConfig {
  /** Bearer token (internal integration token or OAuth access token). */
  token: string;
  /** Override the full base URL (sandbox / test). Takes precedence. */
  baseUrl?: string;
  /** Override subject. Defaults to `workspace:notion`. */
  subject?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["pages"] as const;
type NotionKindGroup = "pages" | "content" | "comments";
const ALL_GROUPS: ReadonlyArray<NotionKindGroup> = ["pages", "content", "comments"];

export function createNotionConnector(
  config: NotionConnectorConfig,
): StatewaveConnector<NotionConnectorConfig, NotionEvent> {
  if (!config.token) {
    throw new ConnectorError(
      "the notion connector requires a token — pass --api-token or set NOTION_API_TOKEN",
      {
        code: "auth_missing",
        connector: "notion",
        hint:
          "create an internal integration at https://www.notion.so/my-integrations and copy the internal integration token",
      },
    );
  }

  const clientOptions: NotionClientOptions = {
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  };
  const client = new NotionClient(clientOptions);

  return {
    id: `notion`,
    name: "Notion",
    source: "notion",

    async configure(_next: NotionConnectorConfig): Promise<void> {
      throw new ConnectorError("notion connector is configured at construction time", {
        code: "unsupported",
        connector: "notion",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{ name: string; status: "ok" | "warn" | "error"; message?: string }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        await client.authProbe();
        details.push({ name: "auth", status: "ok", message: "search probe succeeded" });
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
        message: config.baseUrl ?? "https://api.notion.com",
      });
      return { connector: "notion", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since
        ? options.since instanceof Date
          ? options.since.toISOString()
          : options.since
        : undefined;

      const pages = await client.listPages({ since, maxItems: options.maxItems });

      // Optionally enrich each page with its body (extracted from the
      // child blocks). Gated behind --include pages,content because each
      // page costs an extra API call (or several, for pages with > 100
      // blocks) — the API budget can multiply quickly.
      const wantContent = groups.has("content");
      const enriched: NotionPage[] = [];
      for (const page of pages) {
        if (wantContent) {
          try {
            const body = await client.getPageBody(page.id);
            enriched.push({ ...page, body });
          } catch {
            // A single page failing to render its body shouldn't kill
            // the whole sync — fall through with title-only content.
            enriched.push(page);
          }
        } else {
          enriched.push(page);
        }
      }

      const events: NotionEvent[] = [];
      if (groups.has("pages")) {
        for (const page of enriched) events.push(classifyPage(page));
      }

      // Optionally pull comments per page. Gated behind --include
      // pages,comments because it's another API call per page (the
      // /v1/comments endpoint is paginated separately). Failures on a
      // single page are silent — a permission glitch on one page
      // shouldn't stop the sync from emitting the others.
      if (groups.has("comments")) {
        for (const page of enriched) {
          try {
            const comments = await client.listPageComments(page.id);
            for (const comment of comments) {
              events.push({ type: "comment.posted", page, comment });
            }
          } catch {
            // skip this page's comments; carry on
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);
      const subject = options.subject ?? config.subject ?? defaultSubject();

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapNotionEvent(ev, { subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const created = limited.filter((e) => e.type === "page.created").length;
      const updated = limited.filter((e) => e.type === "page.updated").length;
      const commentsPosted = limited.filter((e) => e.type === "comment.posted").length;
      const details: Record<string, number> = {
        pages_synced: pages.length,
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_page_created: created,
        events_page_updated: updated,
        events_comment_posted: commentsPosted,
      };

      return {
        connector: "notion",
        source: "notion",
        subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: NotionEvent): Promise<StatewaveEpisode> {
      return mapNotionEvent(event, { subject: config.subject ?? defaultSubject() });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<NotionKindGroup> {
  const base = new Set<NotionKindGroup>(
    include?.length
      ? include.filter((i): i is NotionKindGroup => isGroup(i))
      : (DEFAULT_INCLUDE as ReadonlyArray<NotionKindGroup>),
  );
  if (exclude) for (const e of exclude) base.delete(e as NotionKindGroup);
  return base;
}

function isGroup(s: string): s is NotionKindGroup {
  return (ALL_GROUPS as ReadonlyArray<string>).includes(s);
}
