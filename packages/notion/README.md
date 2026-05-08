# @statewavedev/connectors-notion

> Status: **Placeholder** — planned for Phase 4 of the connector roadmap. No implementation yet.

The Notion connector will turn pages and database rows into Statewave episodes — particularly the decision documents and architecture notes teams already keep there.

## Planned scope

- Specific shared pages (allow-listed page IDs only)
- Database rows from explicitly chosen databases
- Frontmatter / property mapping into episode metadata
- Block-level parsing where it materially helps recall (decisions, ADRs)

## Planned subject strategy

- `repo:<owner/name>` for decision docs that govern a specific repository
- `workspace:<notion-workspace>` for general team knowledge
- Related subjects: `decision:<topic>`, `author:<email>`

## Planned event kinds

- `notion.page.updated`
- `notion.decision.published`
- `notion.database.row.updated`

## Planned auth

- Notion internal integration token
- Per-page sharing required — the integration cannot read pages it has not been shared with
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
