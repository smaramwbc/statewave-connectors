// Public types for the Notion connector. Models the slice of Notion's
// REST API the v0.1 pull connector reads — top-level pages and (opt-in)
// the children blocks that make up their body. Databases-as-databases
// (queryable rows) and comments are deliberately out of scope here;
// each warrants its own event kinds.

export type NotionEventKind =
  | "notion.page.created"
  | "notion.page.updated";

/**
 * Discriminator for what kind of parent a Notion page sits under.
 * "workspace" pages are top-level; "database_id" pages are rows inside
 * a database; "page_id" pages are sub-pages of another page.
 */
export type NotionPageParent =
  | { type: "workspace"; workspace: true }
  | { type: "database_id"; database_id: string }
  | { type: "page_id"; page_id: string }
  | { type: "block_id"; block_id: string };

/**
 * One Notion page. Slim shape: the v0.1 connector only needs the title,
 * timestamps, parent pointer, and the public `url` for permalinks. The
 * full Notion API page response has a `properties` map with arbitrary
 * typed columns — we extract just the title here so the mapper stays
 * a pure transformation.
 */
export interface NotionPage {
  id: string;
  /** ISO-8601. */
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  parent: NotionPageParent;
  /** Public Notion URL — `https://www.notion.so/<workspace>/<title>-<id-stripped>`. */
  url: string;
  /** Plaintext title rendered from the `properties.title` rich-text array. */
  title: string;
  /** Optional: the body text rendered from the page's child blocks.
   * Populated by the sync layer when `--include pages,content` is set;
   * left empty in pages-only mode. */
  body?: string;
}

/**
 * A single Notion block — paragraph, heading, list item, etc. The
 * connector reads `type` to discriminate and pulls the matching
 * `<type>.rich_text` array out for plain-text rendering. Other block
 * types (callouts, embeds, tables, columns) are dropped at the
 * extractor; v0.1 keeps the surface small and predictable.
 */
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  /** When set, the block carried at least one rich-text run we
   * extracted into plaintext. When omitted, the block was either a
   * non-text type or had empty content. */
  text?: string;
}

/**
 * Discriminated union the mapper consumes. The sync layer flags
 * each page as either "created" (when `created_time === last_edited_time`)
 * or "updated" so consumers can route on the distinction without
 * re-deriving it from metadata.
 */
export type NotionEvent =
  | { type: "page.created"; page: NotionPage }
  | { type: "page.updated"; page: NotionPage };
