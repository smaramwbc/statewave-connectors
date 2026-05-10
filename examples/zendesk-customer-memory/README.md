# Example — Zendesk customer memory

Turn Zendesk tickets, public replies, and internal notes into Statewave episodes under a `customer:<account>` subject so customer-facing agents can recall what's broken, what's been said, and what's still open — without rebuilding context for every session.

The Zendesk connector ships in two modes; pick the one that fits your deployment:

- **Pull** (`statewave-connectors sync zendesk`) — fetch tickets + comments on demand. Supports `--brands` / `--statuses` allowlists and Incremental Tickets Export delta sync via `--cursor`.
- **Push** (`statewave-connectors listen zendesk`) — webhook receiver that ingests ticket and comment events in real time, with HMAC-SHA256 signature verification and replay-window protection.

## Subject

`customer:<organization_id>` for B2B accounts (preferred — matches how support agents think: "show me Acme's history"), `customer:<requester_id>` for B2C / single-tenant fallback. Pathological tickets with neither fall back to `ticket:<id>`. Override per sync with `--subject account:acme` when you want everything to land on a single subject.

## Pull-mode invocation

```sh
# API token mode (most common)
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_EMAIL=agent@acme.example
export ZENDESK_API_TOKEN=...

statewave-connectors sync zendesk \
  --since 2026-01-01 \
  --include tickets,comments \
  --brands 1 \
  --statuses open,pending,solved \
  --dry-run
```

To create an API token: Zendesk Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → add an API token.

## Push-mode invocation

```sh
export ZENDESK_WEBHOOK_SIGNING_SECRET=...   # from Zendesk Admin → Apps and integrations → Webhooks → <webhook> → Signing secret
export ZENDESK_SUBDOMAIN=acme               # for browser permalinks on emitted episodes
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen zendesk --port 3000
# → http://0.0.0.0:3000/zendesk/events
```

Then create a Zendesk webhook (Admin → Apps and integrations → Webhooks) pointing at the public URL, and wire it to a trigger ("Notify active webhook" action) for the events you care about — Ticket created, Status changed, Comment added.

For the full flag surface, the canonical Liquid templates for ticket and comment payloads, and the episode-kind dispatch table, see the [`@statewavedev/connectors-zendesk` README](../../packages/zendesk/README.md).
