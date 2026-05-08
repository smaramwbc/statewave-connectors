# @statewavedev/connectors-gmail

> Status: **Placeholder** — planned for Phase 4 of the connector roadmap. No implementation yet.

The Gmail connector will turn email threads into Statewave episodes so agents can answer "what's the latest with this contact?" without reading every message in the thread.

## Planned scope

- Threads scoped by Gmail label or query (the user picks what to ingest, not "all of inbox")
- Thread-level summary episodes, not per-message spam
- Attachments are referenced by metadata only, never inlined

## Planned subject strategy

- `contact:<email>` for relationship memory
- `company:<domain>` as a related subject
- Optional `customer:<account>` when accounts map cleanly to email domains

## Planned event kinds

- `gmail.thread.received`
- `gmail.thread.replied`
- `gmail.thread.labeled`

## Planned auth

- Google OAuth, with the least-privilege `gmail.readonly` scope by default
- Per-account, per-label scoping — there is no "ingest everything" mode
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
