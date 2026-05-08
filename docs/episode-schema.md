# Episode schema

A `StatewaveEpisode` is the **single normalized shape** every connector produces. Statewave compiles episodes into durable memory; agents query that memory by subject. The schema is intentionally small and source-agnostic.

```ts
export interface StatewaveEpisode {
  subject: string;
  kind: string;
  text: string;
  occurred_at: string;
  source: {
    type: string;
    id: string;
    url?: string;
  };
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}
```

## Fields

### `subject` (required)

The memory subject this episode is *about*. Subjects are how Statewave groups episodes into compiled memories. Use stable, low-cardinality identifiers:

- `repo:owner/name` — repository memory
- `customer:<account>` — customer memory
- `community:<server>` — community memory
- `contact:<email>` — relationship memory
- `workflow:<id>` — workflow memory

See [subject-strategy.md](./subject-strategy.md) for full guidance.

### `kind` (required)

A dotted, source-prefixed event kind, lower-snake within segments. Examples:

- `github.issue.opened`
- `github.pr.merged`
- `docs.adr`
- `slack.message.posted`
- `zendesk.ticket.solved`

Kinds are **descriptive, not prescriptive** — Statewave does not require any specific value. They exist so retrieval and analytics can filter (`kinds: ["github.pr.merged"]`).

### `text` (required)

Human-readable rendering of the event. Connectors compose this from author + verb + title + body. Keep it self-contained — a memory compiler should be able to summarize the episode without re-fetching the source.

### `occurred_at` (required)

ISO 8601 timestamp of when the event happened in the source — not when the connector ran. This is what timelines and "since" filters use.

### `source` (required)

A pointer back to the original record:

- `source.type` — typed identifier of the source record (e.g. `github.issue`, `markdown`, `zendesk.ticket`)
- `source.id` — stable id within that source (e.g. `acme/widgets#42`)
- `source.url` — optional canonical URL

### `metadata` (optional)

Free-form bag of typed signal: author, labels, milestone, state, related subjects. Connectors should be conservative — metadata that isn't useful for retrieval or downstream consumers belongs on the source, not in the episode.

A common pattern: include `related_subjects: string[]` so a single episode can be surfaced under multiple subjects (`pr:35`, `author:linus`) when querying.

### `idempotency_key` (required)

A stable key derived from the event's **logical identity**, not its current body. Re-running a sync against the same source produces the same key, so Statewave deduplicates rather than double-storing.

Use `idempotencyKey([...parts])` or `EpisodeBuilder.build({..., idempotency_parts})` from core. Common parts: source name, source id, kind, occurred_at.

## Building episodes

```ts
import { EpisodeBuilder } from "@statewave/connectors-core";

const builder = new EpisodeBuilder({
  subject: "repo:acme/widgets",
  metadata: { repo_owner: "acme", repo_name: "widgets" },
});

const episode = builder.build({
  kind: "github.issue.opened",
  text: "ada opened issue #42: CI is flaky",
  occurred_at: "2026-01-01T00:00:00Z",
  source: {
    type: "github.issue",
    id: "acme/widgets#42",
    url: "https://github.com/acme/widgets/issues/42",
  },
  metadata: { author: "ada", labels: ["bug", "ci"] },
  idempotency_parts: ["github", "acme", "widgets", "issue", 42, "github.issue.opened"],
});
```
