# @statewavedev/connectors-discord

Discord connector for Statewave — turns server channel + thread activity into normalized episodes under `community:<guild_id>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Top-level channel message | `discord.message.posted` |
| Reply inside a thread | `discord.thread.replied` |

`v0.1` is pull-mode only — it walks `GET /channels/{id}/messages` for each channel you list, paging back via Discord's snowflake-based `before=<id>` cursor. Real-time ingestion via Discord's Gateway WebSocket (the equivalent of Slack's Socket Mode) is on the roadmap.

## Example episode

```json
{
  "subject": "community:987654321",
  "kind": "discord.message.posted",
  "text": "ada: anyone seen the macos CI flake?",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "discord.message", "id": "111222:333444", "url": "https://discord.com/channels/987654321/111222/333444" },
  "metadata": { "author_id": "555666", "author_label": "ada", "parent_id": null }
}
```

Run `statewave-connectors sync discord --guild 987654321 --channels general --dry-run --json` to see this exact shape.

## Quickstart

```bash
export DISCORD_BOT_TOKEN=...
statewave-connectors sync discord \
  --guild 1100000000000000000 \
  --channels general,help \
  --since 2026-01-01 \
  --dry-run
```

`--guild` takes a server snowflake id (enable **Developer Mode** in Discord → right-click the server icon → **Copy Server ID**). `--channels` accepts ids (snowflake) or names (`general` / `#general`); the bot must already be in the guild for the lookup to work.

## Bot setup

1. Create a Discord application + bot at <https://discord.com/developers/applications>.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent** if you want to read message text (required for ingestion).
3. Generate an invite URL via **OAuth2 → URL Generator** with the `bot` scope and these permissions:
   - `View Channels`
   - `Read Message History`
   - `Read Public Threads` (and `Read Private Threads` for private ones, if applicable)
4. Open the invite URL and add the bot to your server.
5. Copy the **Bot Token** from the Bot tab and export `DISCORD_BOT_TOKEN`.

## Options

```
--guild ID            guild (server) snowflake id (required)
--channels LIST       comma-separated ids (snowflake) or names (required)
--subject SUBJECT     override the default `community:<guild_id>` subject
--since YYYY-MM-DD    earliest message to consider
--max-items N         cap mapped episodes (the client honors this during paging)
--include LIST        allow-list: messages (default)
--dry-run             preview mapped episodes without ingesting (recommended for new use)
```

## Auth

Bot token only (`DISCORD_BOT_TOKEN`). User tokens are explicitly disallowed by Discord's TOS and the connector won't accept them. The token is sent only as the `Authorization: Bot …` header to `discord.com/api/v10/*` and never anywhere else.

## Status

`v0.1.0` — pull-mode ingestion. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned):

- Realtime ingestion via the Gateway WebSocket protocol
- Forum channels (different structure: posts with implicit threads)
- Reactions and pinned messages as signal episodes
- DM ingestion (out of scope; Discord's privacy posture is different from a workspace tool)
