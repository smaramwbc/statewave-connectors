# @statewavedev/connectors-markdown

Markdown / docs connector for Statewave — recursively scans `.md` and `.mdx` files into normalized episodes for project and decision memory.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Path / filename pattern | Episode `kind` |
|---|---|
| Anything under `adrs/` or `ADR-NNNN-…` | `docs.adr` |
| Anything under `rfcs/` or `RFC-NNNN-…` | `docs.rfc` |
| Filenames containing `decision`, paths under `architecture/` | `docs.decision` |
| Everything else | `docs.page` |

The connector parses YAML frontmatter when present (`title`, `date`, …), uses the H1 of the body as a fallback title, and computes idempotency keys from the file's path **plus** content hash.

## Example episode

```json
{
  "subject": "repo:acme/widgets",
  "kind": "docs.adr",
  "text": "Use Redis for caching\n\nWe will use Redis as the cache layer for session data.",
  "occurred_at": "2026-05-18T00:00:00.000Z",
  "source": { "type": "markdown", "id": "docs/adr/0007-caching.md", "url": "file:///repo/docs/adr/0007-caching.md" },
  "metadata": { "path": "docs/adr/0007-caching.md", "title": "Use Redis for caching", "size": 1834 }
}
```

Run `statewave-connectors sync markdown --path ./docs --subject repo:acme/widgets --dry-run --json` to see this exact shape (kinds: `docs.adr`, `docs.rfc`, `docs.decision`, `docs.page`).

## Quickstart

```bash
statewave-connectors sync markdown \
  --path ./docs \
  --subject repo:smaramwbc/statewave \
  --dry-run
```

Local-first — no network calls beyond the optional Statewave ingest.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
