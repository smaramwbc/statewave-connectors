# Connector contract

Every official Statewave connector implements the same contract from `@statewave/connectors-core`. The contract is intentionally small so it stays the same across very different sources — GitHub, Slack, Notion, n8n — and so adding a new connector means filling in a known shape, not inventing one.

## Interface

```ts
export interface StatewaveConnector<TConfig = unknown, TEvent = unknown> {
  id: string;
  name: string;
  source: string;

  configure(config: TConfig): Promise<void>;
  check(): Promise<ConnectorCheckResult>;
  sync(options: SyncOptions): Promise<SyncResult>;
  mapEvent(event: TEvent): Promise<StatewaveEpisode>;
}
```

- `id` is unique per configured instance, e.g. `github:acme/widgets`.
- `name` is a human label (`"GitHub"`).
- `source` is a stable, machine-friendly tag for the source system (`"github"`, `"markdown"`).
- `configure` accepts a connector-specific config object. Some connectors are configured at construction time and reject re-configuration.
- `check` returns environment diagnostics. Always cheap. Never ingests.
- `sync` runs a pull from the source. Honours `SyncOptions` exactly.
- `mapEvent` is a pure function from a source-shaped event to a normalized `StatewaveEpisode`. It must be deterministic.

## SyncOptions

```ts
export interface SyncOptions {
  subject?: string;
  since?: string | Date;
  maxItems?: number;
  dryRun?: boolean;
  include?: ReadonlyArray<string>;
  exclude?: ReadonlyArray<string>;
  redaction?: RedactionOptions;
  json?: boolean;
  cursor?: string;
}
```

Every connector must support:

- **dry-run** — `dryRun: true` returns mapped episodes but **never** ingests.
- **include / exclude** — at least the obvious slicing for that source (e.g. issues vs PRs vs releases for GitHub).
- **maxItems** — caps result size.
- **since** — earliest event time the connector should consider, where the source supports it.
- **stable idempotency keys** — re-running a sync produces the same `idempotency_key` for the same logical event.
- **clear actionable errors** — see [errors](#errors) below.
- **no ingestion unless explicitly commanded** — the default surface (CLI, examples) is dry-run.

## SyncResult

`sync` returns a `SyncResult` containing the mapped episodes, an `ingested` count (always 0 in dry-run), `skipped`, the `cursor` to resume from if applicable, and timing metadata.

## Idempotency

Connectors generate stable `idempotency_key` values from the **logical identity** of the event, not the body. For example, a GitHub issue uses `["github", owner, repo, "issue", number, kind]` — so editing the issue body does not produce a new episode.

Use `idempotencyKey` from core to derive a 32-char hex key, or pass `idempotency_parts` to `EpisodeBuilder.build`.

## Cursors

Long-running connectors persist a cursor through a `SourceStateStore` (in-memory or file-backed). The cursor encodes "where I left off" — a timestamp, an etag, an opaque token. `sync` accepts an explicit `cursor` option to override the stored value.

A connector that does not need cursor-based resumption can ignore them; in that case rely on `since` and idempotency.

## Errors

All connector errors throw `ConnectorError` (or wrap their cause in one) with a typed `code`:

- `config_invalid` — caller error, do not retry
- `auth_failed`, `auth_missing`, `permission_denied` — caller-fixable, do not retry
- `rate_limited`, `network` — retryable; `withRetry` honours `retryable`
- `not_found`, `unsupported`, `mapping_failed`, `ingest_failed`, `unknown`

Errors carry an optional `hint` — the CLI prints it as a second line so end users see *what to do*, not just *what failed*.

## Boundaries

- A connector **must not** depend on another connector package.
- A connector **must not** require credentials for any source other than its own.
- A connector **must not** silently ingest data from a source the user did not explicitly point at.
- A connector should be importable without side effects beyond registering its types.
