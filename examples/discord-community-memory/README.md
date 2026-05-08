# Example — Discord community memory (planned)

> The Discord connector is planned for Phase 2 of the [roadmap](../../docs/roadmap.md) and is not yet implemented. This example file documents the intended shape so contributors and early adopters can plan for it.

When available, this example will show how to turn community Discord activity — channels, threads, forum posts — into Statewave episodes so an agent can answer questions like *"what does the community keep asking about MCP?"*.

## Planned subject

`community:<server-name>`, with `topic:<channel>` and `user:<discord-id>` as related subjects.

## Planned invocation

```sh
# Will not run yet
statewave-connectors sync discord \
  --server statewave-community \
  --subject community:statewave \
  --dry-run
```

Until the connector lands, follow [the roadmap](../../docs/roadmap.md) for status.
