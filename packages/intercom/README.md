# @statewave/connectors-intercom

> Status: **Placeholder** — planned for Phase 3 of the connector roadmap. No implementation yet.

The Intercom connector will turn conversations and contact notes into Statewave episodes so customer-facing agents can recall the full history with a contact across sessions.

## Planned scope

- Conversations (opened, updated, closed)
- Contact-level notes (admin notes, tags)
- Conversation parts attributed to specific operators

## Planned subject strategy

- `customer:<account>` for B2B accounts
- `contact:<email>` for individual contacts
- Related subjects: `conversation:<id>`, `operator:<email>`

## Planned event kinds

- `intercom.conversation.opened`
- `intercom.conversation.updated`
- `intercom.note.added`

## Planned auth

- Intercom access token (read-only) per workspace
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
