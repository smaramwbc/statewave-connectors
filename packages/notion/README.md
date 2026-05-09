# @statewavedev/connectors-notion

Notion connector for Statewave — turns pages (and optionally their body content) into normalized decision-memory episodes.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Page where `created_time == last_edited_time` (newly created) | `notion.page.created` |
| Page that has been edited since creation | `notion.page.updated` |
| Page-level discussion comment (v0.1.1) | `notion.comment.posted` |

Page body extraction is off by default — pass `--include pages,content` to also walk every page's child blocks and render them to plaintext (one extra API call per page, plus pagination if the page has > 100 blocks).

## Quickstart

```bash
export NOTION_API_TOKEN=secret_...
statewave-connectors sync notion --since 2026-01-01 --dry-run

# With body content extraction
statewave-connectors sync notion --include pages,content --subject repo:acme/platform --dry-run
```

## Auth

Bearer only. Both **internal integration tokens** (the common case) and **OAuth access tokens** (public integrations) ride on the same `Authorization: Bearer <token>` header — no mode discriminator. The connector itself never runs the OAuth dance; operators with public integrations bring their own already-issued access token.

To create an internal integration token:

1. Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
2. **+ New integration** → give it a name (e.g. "Statewave decision memory")
3. Pick the workspace and capabilities (read content is enough; comments + content updates are out of scope for v0.1)
4. Copy the **Internal Integration Token**
5. **Crucial**: in Notion, share each page or database with the integration (the integration only sees pages it's been invited to). Use the `…` menu on a page → **Connections** → **Connect to** → pick your integration. Sharing a database shares all rows.

The connector pins `Notion-Version: 2022-06-28`. Override via the `NotionClient` constructor if you need a specific version. The token is used **only** by this connector and **only** sent to `https://api.notion.com`.

## Subject routing

Notion doesn't have a natural customer or organizational axis exposed at the page level — pages sit under a workspace, a database, or another page. The default is `workspace:notion`, which is fine for "all my decision docs" use cases.

For more useful retrieval, **set `--subject` per sync to whatever organizational unit fits your retrieval shape**:

- `--subject repo:acme/platform` for decision docs that govern a specific repository (matches the markdown connector's default for ADRs)
- `--subject project:onboarding-2026` for project-scoped decisions
- `--subject team:platform-eng` for team-scoped notes

Page metadata always carries `parent_type`, `parent_id`, `page_id`, `page_url`, `created_time`, `last_edited_time`, and `archived` so consumers can filter or re-route at retrieval time.

## Body extraction

When `--include pages,content` is passed, the connector walks each page's children blocks via `/v1/blocks/{id}/children` and renders the most common block types to plaintext (with markdown-style prefixes for readability):

| Block type | Rendered as |
|---|---|
| `paragraph` | plain text |
| `heading_1` | `# text` |
| `heading_2` | `## text` |
| `heading_3` | `### text` |
| `bulleted_list_item` | `- text` |
| `numbered_list_item` | `1. text` |
| `to_do` | `[ ] text` or `[x] text` |
| `quote` | `> text` |
| `code` | triple-backtick fenced block with language |

Other block types (callouts, embeds, tables, columns, child databases, synced blocks) are **dropped at the extractor**. v0.1 keeps the surface small and predictable; richer rendering lands as the use case earns it.

## Options

```
--api-token TOKEN      Notion bearer token (internal integration or OAuth access token) — required

--subject SUBJECT      override the default `workspace:notion` subject
--since YYYY-MM-DD     skip pages whose last_edited_time is older
--max-items N          cap mapped episodes
--include LIST         allow-list — `pages`, `content`, `comments` (default: pages only). `comments` (v0.1.1) opts into page-level discussion comment ingestion via /v1/comments — one extra API call per page, plus pagination.
--exclude LIST         deny-list (e.g. --exclude pages to fetch nothing)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Status

`v0.1.1` — pull mode for pages + (opt-in) body content + (opt-in) page-level discussion comments. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned for follow-ups):

- Database queries (treating a database as a typed row source rather than a page collection)
- _(landed in v0.1.1)_ ~~Comment ingestion (`/v1/comments`)~~ — page-level discussion comments now ship under `--include pages,comments`. Per-block inline comments still queued.
- Property mapping into structured episode metadata (today only the title property is read; other typed columns are dropped)
- Tables, callouts, embeds, columns, synced blocks in body rendering
- Webhook (push) mode — Notion's outbound webhooks are still in private beta as of API version `2022-06-28`
