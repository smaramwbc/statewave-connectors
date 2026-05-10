# Example — Discord community memory

Turn community Discord activity — channels, threads, forum posts — into Statewave episodes so an agent can answer questions like *"what does the community keep asking about MCP?"* without re-reading the whole server every time.

The Discord connector ingests in pull mode against the Discord REST API: a bot token, an explicit `--guild`, and an explicit `--channels` allowlist.

## Subject

`community:<server-name>` for the whole server, with `topic:<channel>` and `user:<discord-id>` as related subjects. Override per sync with `--subject` when you want all channels in the run to land on a single subject.

## Invocation

```sh
export DISCORD_BOT_TOKEN=...

statewave-connectors sync discord \
  --guild 123456789012345678 \
  --channels 234567890123456789,345678901234567890 \
  --subject community:statewave \
  --include messages,thread_replies \
  --dry-run
```

Discord IDs are 64-bit snowflakes (long numeric strings). Find them by enabling **Developer Mode** in Discord (User Settings → Advanced) and right-clicking a channel / server → **Copy ID**.

For the full flag surface, episode kinds (`discord.message.posted`, `discord.thread.replied`), and the bot-scope list, see the [`@statewavedev/connectors-discord` README](../../packages/discord/README.md).
