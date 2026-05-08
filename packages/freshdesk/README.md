# @statewavedev/connectors-freshdesk

> Status: **Placeholder** — planned for Phase 3 of the connector roadmap. No implementation yet.

The Freshdesk connector will turn tickets and conversations into Statewave episodes for customer support memory.

## Planned scope

- Tickets (opened, updated, resolved)
- Public and private replies (private opt-in only)
- Solutions/KB references attached to a ticket

## Planned subject strategy

- `customer:<account>`
- Related subjects: `ticket:<id>`, `product:<area>`

## Planned event kinds

- `freshdesk.ticket.opened`
- `freshdesk.ticket.updated`
- `freshdesk.ticket.resolved`

## Planned auth

- Freshdesk API key + domain per connector instance
- Read-only scope by default
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
