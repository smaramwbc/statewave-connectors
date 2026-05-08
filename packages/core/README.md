# @statewave/connectors-core

Shared TypeScript types and utilities used by every Statewave connector.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. You probably want a specific connector (e.g. `@statewave/connectors-github`) — this package is the contract they all share.

## What's here

- `StatewaveConnector` — the interface every connector implements
- `StatewaveEpisode` — the single normalized event shape
- `EpisodeBuilder` — ergonomic helper for assembling episodes with sane defaults
- `idempotencyKey`, `summarizeEpisodes` — small helpers
- `withRetry` — exponential-backoff retry with jitter and abort signals
- `redact` / `RedactionRule` — best-effort scrubbing for emails, phones, common API key shapes
- `MemorySourceStateStore` / `FileSourceStateStore` — pluggable cursor persistence
- `ConnectorError` — typed errors with `code`, `hint`, `retryable`

## Episode shape

```ts
interface StatewaveEpisode {
  subject: string;
  kind: string;
  text: string;
  occurred_at: string;
  source: { type: string; id: string; url?: string };
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}
```

## Status

`v0.1.0` preview — see the [release notes](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md) and [connector contract](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/connector-contract.md).
