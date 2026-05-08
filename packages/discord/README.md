# @statewave/connectors-discord

> Status: **Placeholder** — planned for Phase 2 of the connector roadmap. No implementation yet.

The Discord connector will turn community server activity — channels, threads, forum posts — into Statewave episodes so agents can answer "what does the community keep asking about?" or "what was decided in the #design thread last month?".

## Planned scope

- Public channels and threads in opted-in servers
- Forum channels (post + replies + solved status)
- Reactions as lightweight signal
- No private DMs

## Planned subject strategy

- `community:<server-name>` for community memory
- `topic:<channel-name>` as a related subject
- `user:<discord-id>` as a related subject when the question is asked by a known user

## Planned event kinds

- `discord.message.posted`
- `discord.thread.replied`
- `discord.forum.opened`
- `discord.forum.solved`

## Planned auth

- Discord bot token, scoped to a single server
- Server admins must explicitly invite the bot before any ingestion
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
