---
title: "Dry-run is the default for connector workflows"
status: accepted
date: 2026-04-22
---

# ADR-0002 — Dry-run-first connector workflows

## Context

We don't want a `git pull && pnpm install` to silently mirror private data
to a remote service. Connectors must show their work before sending anything.

## Decision

- `--dry-run` is the documented default in every connector example
- The CLI refuses to ingest unless `STATEWAVE_URL` is explicitly set
- Best-effort redaction (email, phone, common API keys) ships in core but is
  off by default; users opt in per sync

## Consequences

- New users can preview every mapped episode locally before any network call.
- Operators can pipe dry-run output into review tools.
- Re-runs are safe: every episode has a stable `idempotency_key`, so Statewave
  deduplicates rather than double-storing.
