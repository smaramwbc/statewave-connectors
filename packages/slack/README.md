# @statewave/connectors-slack

> Status: **Placeholder** — planned for Phase 2 of the connector roadmap. No implementation yet.

The Slack connector will turn workspace and channel activity into Statewave episodes so agents can recall how a customer or team has been talking — without you having to stuff raw Slack history into a prompt.

## Planned scope

- Channels and threads (with explicit allow-list)
- Direct messages — only when explicitly opted-in per workspace
- Reactions and pinned messages as lightweight signal episodes
- Optional channel summarization episodes ("daily channel summary")

## Planned subject strategy

- `customer:<account>` for shared support channels
- `team:<workspace>` for internal channels
- `contact:<email>` for DM threads with named contacts (opt-in)

See [docs/subject-strategy.md](../../docs/subject-strategy.md) for the full strategy.

## Planned event kinds

- `slack.message.posted`
- `slack.thread.replied`
- `slack.reaction.added`
- `slack.channel.summary`

## Planned auth

- Slack bot or user OAuth token (least privilege — `channels:history` scope at most)
- No DM ingestion without explicit per-workspace opt-in
- Credentials are local to this connector — they are never required to use any other Statewave connector

## Track progress

Watch [docs/roadmap.md](../../docs/roadmap.md) and the GitHub project board.
