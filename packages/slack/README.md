# @statewavedev/connectors-slack

Slack connector for Statewave — turns channel and thread activity into normalized episodes under `team:<team_id>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` | Mode |
|---|---|---|
| Top-level channel message | `slack.message.posted` | pull + webhook |
| Reply inside a thread | `slack.thread.replied` | pull + webhook |
| Reaction added to a message | `slack.reaction.added` | webhook (v0.3) |
| Reaction removed from a message | `slack.reaction.removed` | webhook (v0.3) |
| Message pinned in a channel | `slack.pin.added` | webhook (v0.3) |
| Message unpinned in a channel | `slack.pin.removed` | webhook (v0.3) |
| Top-level DM message | `slack.dm.message.posted` | pull (v0.3.1) |
| Reply inside a DM thread | `slack.dm.thread.replied` | pull (v0.3.1) |
| Top-level MPIM (group DM) message | `slack.mpim.message.posted` | pull (v0.3.2) |
| Reply inside an MPIM thread | `slack.mpim.thread.replied` | pull (v0.3.2) |

v0.1 is pull-mode only — it walks `conversations.history` for each channel you list (and `conversations.replies` for any threads with replies). Live Events-API mode is on the roadmap.

## Example episode

```json
{
  "subject": "team:T0ACME",
  "kind": "slack.message.posted",
  "text": "ada: deploy is green — shipping v1.0",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "slack.message", "id": "C123ABC:1716196320.000100" },
  "metadata": { "author_id": "U0ADA", "channel": "C123ABC" }
}
```

Run `statewave-connectors sync slack --channels general --subject team:T0ACME --dry-run --json` to see this exact shape.

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
--channels LIST       comma-separated ids or names (required unless --include-dms)
--include-dms         also ingest DMs the bot has access to (im:read + im:history scopes)
--include-mpim        also ingest multi-party DMs the bot is in (mpim:read + mpim:history scopes)
--subject SUBJECT     override the default `team:<team_id>` subject
--since YYYY-MM-DD    earliest message to consider
--max-items N         cap mapped episodes
--include LIST        allow-list: messages, thread_replies (default: both)
--exclude LIST        deny-list (e.g. --exclude thread_replies for top-level only)
--resolve-users       expand <@Uxxx> mentions to display names (extra API calls per author)
--dry-run             preview mapped episodes without ingesting (recommended for new use)
```

### Direct messages (v0.3.1)

Pass `--include-dms` to also pull DM history that the bot user has access to. Each DM lands on its own subject — `dm:<other_user_id>` — so a single sync can mix `team:<team_id>` channel episodes and per-user DM episodes without colliding. DMs use the `slack.dm.message.posted` and `slack.dm.thread.replied` kinds so consumers can route on them separately.

```bash
statewave-connectors sync slack --include-dms --since 2026-01-01 --dry-run
statewave-connectors sync slack --channels general,support --include-dms --dry-run
```

The bot needs the `im:read` scope (to discover DM conversations) and `im:history` (to read messages). Bot tokens can only see DMs the bot is *itself* a participant in — i.e. DMs between a human and the bot user. They cannot read DMs between two humans.

### Multi-party DMs / group DMs (v0.3.2)

Pass `--include-mpim` to also pull multi-party DM history. MPIMs (group DMs in the Slack UI) have no single "other party" — multiple humans share one conversation — so each MPIM lands on its own `mpim:<channel_id>` subject (Slack's stable channel id). MPIMs emit the separate kinds `slack.mpim.message.posted` and `slack.mpim.thread.replied` so consumers can route on them without parsing metadata.

```bash
statewave-connectors sync slack --include-mpim --since 2026-01-01 --dry-run
statewave-connectors sync slack --channels general,support --include-dms --include-mpim --dry-run
```

The bot needs the `mpim:read` scope (to discover group-DM conversations) and `mpim:history` (to read messages). Same privacy posture as DMs — group DMs are opt-in because other participants in shared workspaces didn't necessarily consent to having their messages mirrored elsewhere.

## Auth

Bot token only (`xoxb-…`). User tokens, app-level tokens, and OAuth flows are not used in v0.1 — bot tokens are the right default for ingest, since the audit trail in your workspace shows the bot as the reader.

The token is read **only** from `SLACK_BOT_TOKEN` and **only** by this connector. It is never sent anywhere except `slack.com/api/*`.

## Live mode (v0.2)

The same package also ships a Slack Events-API webhook receiver — a pure `(Request) => Promise<Response>` handler that verifies HMAC signatures, dedups Slack retries by `event_id`, and ingests every allowed channel message in real time.

### Run it as a daemon (zero-config)

```bash
export SLACK_SIGNING_SECRET=...           # Slack app → Basic Information → Signing Secret
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...              # only if your instance enforces auth

statewave-connectors listen slack \
  --channels C01ABCDEF,C02XYZ123 \
  --port 3000
# → http://0.0.0.0:3000/slack/events
```

Then expose `:3000` to the internet (ngrok / Cloudflare Tunnel / your ingress) and paste the public URL into your Slack app's **Event Subscriptions** page. Subscribe to `message.channels` (and `message.groups` for private channels). The first request Slack sends is a `url_verification` challenge — the handler echoes it automatically.

### Or mount on Vercel / Cloudflare / Express

The handler is framework-agnostic:

```ts
// app/api/slack/route.ts (Vercel / Next.js App Router)
import { createSlackWebhookHandler } from '@statewavedev/connectors-slack'

const handler = createSlackWebhookHandler({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  channels: ['C01ABCDEF'],
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
})

export const POST = (req: Request) => handler(req)
```

```ts
// Cloudflare Workers
import { createSlackWebhookHandler } from '@statewavedev/connectors-slack'

export default {
  async fetch(req: Request, env: Env) {
    const handler = createSlackWebhookHandler({
      signingSecret: env.SLACK_SIGNING_SECRET,
      channels: ['C01ABCDEF'],
      statewaveUrl: env.STATEWAVE_URL,
      statewaveApiKey: env.STATEWAVE_API_KEY,
    })
    return handler(req)
  },
}
```

```ts
// Express (or any Node http server) — adapt with the helper of your choice
import express from 'express'
import { createSlackWebhookHandler } from '@statewavedev/connectors-slack'

const handler = createSlackWebhookHandler({ signingSecret, channels, statewaveUrl })
const app = express()
app.post('/slack/events', express.raw({ type: '*/*' }), async (req, res) => {
  const fetchReq = new Request('http://x/slack/events', {
    method: 'POST',
    headers: req.headers as any,
    body: req.body, // raw bytes — required for signature verification
  })
  const r = await handler(fetchReq)
  res.status(r.status).set(Object.fromEntries(r.headers)).send(await r.text())
})
app.listen(3000)
```

### Cross-process deduplication

The default `InMemoryDedupCache` is single-process. For multi-replica deployments behind a load balancer, plug in a shared cache:

```ts
import { createSlackWebhookHandler, type SlackDedupCache } from '@statewavedev/connectors-slack'

class RedisDedupCache implements SlackDedupCache {
  async seenOrMark(eventId: string): Promise<boolean> {
    // SET key NX EX 600 returns null if it already existed
    const set = await redis.set(`slack:event:${eventId}`, '1', 'NX', 'EX', 600)
    return set === null
  }
}

const handler = createSlackWebhookHandler({
  signingSecret,
  channels,
  statewaveUrl,
  dedupCache: new RedisDedupCache(),
})
```

## Status

`v0.4.0` — pull mode (messages + threads + DMs + MPIMs) + Events-API webhook handler (messages, reactions, pins, DMs, group DMs). See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

### Subscribing to reactions + pins

In your Slack app's **Event Subscriptions → Subscribe to bot events**, add (in addition to the message events from v0.2):

- `reaction_added`, `reaction_removed` — needs the `reactions:read` scope
- `pin_added`, `pin_removed` — needs the `pins:read` scope

The webhook handler dispatches all four event types automatically; the channel allowlist applies the same way as for messages.

### Subscribing to DM + MPIM webhook events (v0.4.0)

The webhook handler also dispatches DM and group-DM messages when the Slack app is configured for them. Two opt-in flags gate the path so a channel-only deployment doesn't accidentally start ingesting DMs the moment someone toggles a Slack-app subscription:

```ts
createSlackWebhookHandler({
  signingSecret,
  channels: ['C01ABCDEF'],
  acceptDms: true,    // dispatch message.im events to slack.dm.* on dm:<user>
  acceptMpim: true,   // dispatch message.mpim events to slack.mpim.* on mpim:<channel>
  statewaveUrl,
})
```

Subscribe to `message.im` (needs `im:history`) and `message.mpim` (needs `mpim:history`). The handler honors the existing dedup-by-`event_id` retry guard. DM/MPIM events bypass the channel allowlist because the channel id is a synthetic `D…` / `G…` snowflake the operator can't predict.

Out of scope (still planned):

- Socket Mode (alternative WebSocket transport for the same logical layer)
- Pull-mode reactions / pinned (would inflate the per-channel API budget; webhook is the right place for these signals)
- Channel summarization episodes (deferred until LLM-architecture call lands)
