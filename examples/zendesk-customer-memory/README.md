# Example — Zendesk customer memory (planned)

> The Zendesk connector is planned for Phase 3 of the [roadmap](../../docs/roadmap.md) and is not yet implemented. This example file documents the intended shape.

When available, this example will show how to ingest Zendesk tickets and replies into Statewave under a `customer:<account>` subject so customer-facing agents can recall what's broken, what's been said, and what's still open — without rebuilding context for every session.

## Planned subject

`customer:<account-slug>`, with `ticket:<id>` and `product:<area>` as related subjects.

## Planned invocation

```sh
# Will not run yet
statewave-connectors sync zendesk \
  --subdomain acme \
  --subject customer:acme \
  --dry-run
```

Until the connector lands, follow [the roadmap](../../docs/roadmap.md) for status.
