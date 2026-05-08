# Privacy & redaction

Statewave Connectors are designed around one rule: **never ingest data without explicit user command**. This document explains the safety primitives every official connector inherits, and the boundaries you should expect.

## Defaults

- **Dry-run is the default in examples and docs.** Every example you'll find shows `--dry-run` first.
- **`STATEWAVE_URL` must be set before any ingestion can happen.** The CLI refuses to ingest if it's missing.
- **No auto-discovery.** The CLI does not crawl your filesystem, your Slack workspaces, or your inbox looking for sources. You point it at one source, one subject, one run.
- **Per-connector credentials.** Each connector reads only the credentials it needs. The GitHub connector does not need (and never reads) Slack tokens, and vice versa.

## Dry-run

`--dry-run` runs the read path and the mapper, prints the resulting episodes, and **does not** call the Statewave ingest API. Use it before every first-time sync.

```sh
statewave-connectors sync github --repo acme/widgets --subject repo:acme/widgets --dry-run
statewave-connectors sync markdown --path ./docs --subject repo:acme/widgets --dry-run
```

## Built-in redaction

Core ships best-effort redaction in `redact()` and `redactEpisodeText()`. Each rule is opt-in:

- `email: true` — strips `name@domain` patterns.
- `phone: true` — strips long digit runs that look like phone numbers.
- `secrets: true` — best-effort detection for common token shapes: GitHub tokens, OpenAI/Anthropic keys, AWS access keys, Slack tokens, JWTs, PEM private-key blocks.
- `rules: [...]` — pass any number of `{ name, pattern, replacement }` for custom regex.

Redaction runs **before** the episode is sent to Statewave (and before the dry-run print).

> Best-effort detection is not perfect detection. Treat redaction as defense-in-depth, not as a substitute for not piping secrets into a shared system in the first place.

## Include / exclude filters

Use `--include` and `--exclude` to slice what a connector reads:

```sh
# Only issues, no PRs, no releases
statewave-connectors sync github \
  --repo acme/widgets \
  --include issues

# Skip a folder
statewave-connectors sync markdown \
  --path ./docs \
  --exclude internal-only
```

Filters are applied at read time so an excluded source is never even mapped, let alone ingested.

## Local-first behaviour

- The Markdown connector is fully local — no network calls beyond the optional Statewave ingest.
- The GitHub connector talks only to `api.github.com` (configurable via `baseUrl` for GHES).
- The CLI does not phone home. There is no telemetry.
- Source state (cursors) is stored either in memory or in a file you specify.

## Connector-specific credentials

The principle is one-way: if you only use Markdown, you never need a GitHub token. If you only use GitHub, you never need Slack credentials. The convenience meta-package `@statewavedev/connectors` does **not** load credentials — it just re-exports types and factories.

## What we don't do

- We do not auto-detect content as "sensitive" and quietly drop it.
- We do not encrypt episode bodies at the connector layer — that's Statewave's responsibility downstream.
- We do not ship managed integrations that bring their own OAuth flow into a hosted server. Connectors run where you run them.

## When in doubt

Add `--dry-run` and read the output. If the printed episodes contain anything you didn't expect to share with Statewave, refine `--include`, `--exclude`, or `--redaction` flags before removing `--dry-run`.
