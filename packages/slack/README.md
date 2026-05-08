# @statewavedev/connectors-slack

Slack connector for Statewave — turns channel and thread activity into normalized episodes under `team:<team_id>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Top-level channel message | `slack.message.posted` |
| Reply inside a thread | `slack.thread.replied` |

v0.1 is pull-mode only — it walks `conversations.history` for each channel you list (and `conversations.replies` for any threads with replies). Live Events-API mode is on the roadmap.

## Quickstart

```bash
export SLACK_BOT_TOKEN=xoxb-…
statewave-connectors sync slack \
  --channels general,support \
  --subject team:acme \
  --since 2026-01-01 \
  --dry-run
```

`--channels` accepts ids (`C0123…`) or names (`general`, `#general`). At least one is required so you don't accidentally pull a whole workspace on first run. The bot needs `channels:history` + `channels:read` (and the `groups:*` equivalents for private channels you want it to see — invite the bot first).

## Options

```
--channels LIST       comma-separated ids or names (required)
--subject SUBJECT     override the default `team:<team_id>` subject
--since YYYY-MM-DD    earliest message to consider
--max-items N         cap mapped episodes
--include LIST        allow-list: messages, thread_replies (default: both)
--exclude LIST        deny-list (e.g. --exclude thread_replies for top-level only)
--resolve-users       expand <@Uxxx> mentions to display names (extra API calls per author)
--dry-run             preview mapped episodes without ingesting (recommended for new use)
```

## Auth

Bot token only (`xoxb-…`). User tokens, app-level tokens, and OAuth flows are not used in v0.1 — bot tokens are the right default for ingest, since the audit trail in your workspace shows the bot as the reader.

The token is read **only** from `SLACK_BOT_TOKEN` and **only** by this connector. It is never sent anywhere except `slack.com/api/*`.

## Status

`v0.1.0` preview — see [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned):

- Live Events-API ingestion (webhook + signature verification, Socket Mode option)
- Direct messages (opt-in per workspace)
- Reactions and pinned messages as signal episodes
- Channel summarization episodes
