# Example — Slack support memory

Turn a shared customer-support Slack channel into Statewave episodes under a `customer:<account>` subject so an agent can recall the full back-and-forth across the relationship — without rebuilding context for every session.

The Slack connector ships in two modes; pick the one that fits your deployment:

- **Pull** (`statewave-connectors sync slack`) — fetch channel + thread history on demand, e.g. as a backfill or daily catch-up. Works with a bot token + an explicit `--channels` allowlist.
- **Push** (`statewave-connectors listen slack`) — long-running daemon that subscribes to Slack's Events API and ingests messages, replies, reactions, and pins in real time. Optional opt-in for DMs and group DMs.

## Subject

`customer:<account-slug>` for shared customer channels, with `team:<workspace>` for internal channels. Override per sync with `--subject` when you want all channels in the run to land on a single subject.

## Pull-mode invocation

```sh
export SLACK_BOT_TOKEN=xoxb-...

statewave-connectors sync slack \
  --channels C0123ACME \
  --subject customer:acme \
  --since 2026-01-01 \
  --include messages,thread_replies \
  --dry-run
```

Slack's Web API only accepts channel IDs (`C…`), not names — find them in Slack: channel name → settings → bottom of dialog.

## Push-mode invocation

```sh
export SLACK_SIGNING_SECRET=...
export SLACK_BOT_TOKEN=xoxb-...
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen slack --channels C0123ACME --port 3000
# → http://0.0.0.0:3000/slack/events
```

Then point the Slack app's **Event Subscriptions** URL at the public address (via ngrok / Cloudflare Tunnel / your own ingress).

For the full set of flags, episode kinds, and the exact Slack-app scope list, see the [`@statewavedev/connectors-slack` README](../../packages/slack/README.md).
