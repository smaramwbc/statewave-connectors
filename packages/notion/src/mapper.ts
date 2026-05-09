// Notion-event → Statewave-episode mapping. Side-effect-free; the
// connector resolves pages and (optionally) extracts their body before
// calling this so the mapper itself is a pure transformation.

import { EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { NotionComment, NotionEvent, NotionEventKind, NotionPage } from "./types.js";

export interface MapperOptions {
  /** Override for the auto-derived subject. */
  subject?: string;
}

/**
 * Subject default: `workspace:notion`. Notion doesn't have a natural
 * customer or organizational axis exposed at the page level — pages
 * sit under a workspace, a database, or another page. Operators who
 * want the episodes to land on something more specific (a particular
 * project, repo, or product) should pass `--subject repo:owner/name`
 * or whichever string fits their retrieval shape.
 */
export function defaultSubject(): string {
  return `workspace:notion`;
}

export function mapNotionEvent(
  event: NotionEvent,
  options: MapperOptions = {},
): StatewaveEpisode {
  if (event.type === "comment.posted") {
    return mapComment(event.page, event.comment, options);
  }
  return mapPage(event, options);
}

function mapPage(
  event: { type: "page.created" | "page.updated"; page: NotionPage },
  options: MapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject();
  const page = event.page;
  const kind: NotionEventKind =
    event.type === "page.created" ? "notion.page.created" : "notion.page.updated";
  const title = page.title.trim() || "(untitled page)";
  const body = (page.body ?? "").trim();
  const verb = event.type === "page.created" ? "created page" : "updated page";
  const headline = `${verb} "${title}"`;
  const text = body ? `${headline}\n\n${body}` : headline;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      page_id: page.id,
      page_title: title,
      page_url: page.url,
      created_time: page.created_time,
      last_edited_time: page.last_edited_time,
      archived: page.archived,
      parent_type: page.parent.type,
      parent_id:
        page.parent.type === "database_id"
          ? page.parent.database_id
          : page.parent.type === "page_id"
            ? page.parent.page_id
            : page.parent.type === "block_id"
              ? page.parent.block_id
              : null,
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: event.type === "page.created" ? page.created_time : page.last_edited_time,
    source: {
      type: kind === "notion.page.created" ? "notion.page.create" : "notion.page.update",
      id: `page:${page.id}`,
      url: page.url,
    },
    // Page id alone uniquely identifies a Notion page, but we include
    // last_edited_time so a re-edit produces a new episode rather than
    // dedup'ing against the prior version.
    idempotency_parts: [
      "notion",
      page.id,
      kind,
      kind === "notion.page.updated" ? page.last_edited_time : page.created_time,
    ],
  });
}

/**
 * Helper for the sync layer: turn a NotionPage into the appropriate
 * NotionEvent based on whether `created_time` and `last_edited_time`
 * are equal. Even one second of drift means the page has been touched
 * since creation and should map to "updated".
 */
export function classifyPage(page: NotionPage): NotionEvent {
  if (page.created_time === page.last_edited_time) {
    return { type: "page.created", page };
  }
  return { type: "page.updated", page };
}

function mapComment(
  page: NotionPage,
  comment: NotionComment,
  options: MapperOptions,
): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject();
  const title = page.title.trim() || "(untitled page)";
  const author = comment.author_name?.trim() || (comment.author_id ? `user:${comment.author_id}` : "unknown author");
  const text = comment.text.trim()
    ? `${author} commented on "${title}": ${comment.text.trim()}`
    : `${author} commented on "${title}"`;

  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      page_id: page.id,
      page_title: title,
      page_url: page.url,
      comment_id: comment.id,
      discussion_id: comment.discussion_id,
      author_id: comment.author_id ?? null,
      author_name: comment.author_name ?? null,
    },
  });

  return builder.build({
    kind: "notion.comment.posted",
    text,
    occurred_at: comment.created_time,
    source: {
      type: "notion.comment",
      id: `comment:${comment.id}`,
      url: page.url,
    },
    idempotency_parts: ["notion", "comment", comment.id],
  });
}
