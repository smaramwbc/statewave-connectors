# Example — Slack support memory (planned)

> The Slack connector is planned for Phase 2 of the [roadmap](../../docs/roadmap.md) and is not yet implemented. This example file documents the intended shape.

When available, this example will show how to ingest a shared support channel into Statewave under a `customer:<account>` subject so an agent can recall the full back-and-forth across the relationship.

## Planned subject

`customer:<account-slug>` for shared customer channels, with `team:<workspace>` for internal channels.

## Planned invocation

```sh
# Will not run yet
statewave-connectors sync slack \
  --channel acme-support \
  --subject customer:acme \
  --dry-run
```

Until the connector lands, follow [the roadmap](../../docs/roadmap.md) for status.
