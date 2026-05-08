---
title: "Use Statewave Connectors for repo memory"
status: accepted
date: 2026-04-15
---

# ADR-0001 — Use Statewave Connectors for repo memory

## Context

The team wants coding agents to recall prior decisions without re-reading the
whole repo on every prompt. We currently rely on raw chat history, which loses
context across sessions and bloats prompts.

## Decision

We will adopt Statewave Connectors. Specifically:

- the **GitHub** connector ingests issues, PRs, comments, reviews, and releases under `repo:<owner>/<repo>`
- the **Markdown** connector ingests this `docs/` folder under the same subject
- the **MCP server** exposes the resulting memory to any MCP-compatible agent

## Consequences

- Agents can call `statewave_get_context` with `subject=repo:<owner>/<repo>` and
  receive ranked, token-bounded context — including the substance of this ADR.
- Memory survives session boundaries and tool changes.
- Adding new sources later (Slack, Notion, …) does not require re-ingesting
  what's already here.
