# @statewavedev/connectors-zendesk

> Status: **Placeholder** — planned for Phase 3 of the connector roadmap. No implementation yet.

The Zendesk connector will turn support tickets into Statewave episodes so agents have customer-specific memory — what's broken for this account, what they've already been told, what's still open.

## Planned scope

- Tickets (open, updated, solved)
- Public and internal comments (internal opt-in only)
- Macros applied (signal that a known playbook was used)
- Ticket tags as metadata, not as separate episodes

## Planned subject strategy

- `customer:<account>` — most common
- Related subjects: `ticket:<id>`, `product:<area>`, `assignee:<agent>`

## Planned event kinds

- `zendesk.ticket.opened`
- `zendesk.ticket.updated`
- `zendesk.ticket.solved`
- `zendesk.comment.added`

## Planned auth

- Zendesk API token with read-only scope by default
- Subdomain configured per connector instance
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
