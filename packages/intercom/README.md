# @statewavedev/connectors-intercom

Intercom connector for Statewave — turns conversations, replies, and admin notes into normalized episodes scoped to the customer (primary company or contact).

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Conversation opened (subject + source body) | `intercom.conversation.created` |
| Conversation marked closed | `intercom.conversation.closed` |
| Public reply on a conversation | `intercom.conversation.replied` |
| Admin internal note on a conversation | `intercom.conversation.note_added` |

Replies and notes are off by default — pass `--include conversations,parts` to also walk every conversation's part stream (one extra API call per conversation). System parts (assignment, close, snooze, away_mode, …) are dropped at the mapper.

## Quickstart

```bash
export INTERCOM_ACCESS_TOKEN=...
statewave-connectors sync intercom --since 2026-01-01 --dry-run

# EU workspace
INTERCOM_REGION=eu statewave-connectors sync intercom \
  --include conversations,parts \
  --dry-run
```

## Auth

Bearer only. Both **personal access tokens** (internal apps) and **OAuth access tokens** (public apps) ride on the same `Authorization: Bearer <token>` header — no mode discriminator. The connector itself never runs the OAuth dance; operators with public apps bring their own already-issued access token.

To create a personal access token: Intercom Settings → Workspace settings → Developers → Your apps → New app → Authentication → Personal access token.

The token is used **only** by this connector and **only** sent to `https://api.<region>.intercom.io`.

## Region

Intercom hosts customer data in three regions:

| `--region` | Hostname |
|---|---|
| `us` (default) | `api.intercom.io` |
| `eu` | `api.eu.intercom.io` |
| `au` | `api.au.intercom.io` |

The connector pins `Intercom-Version: 2.13`. Override via `IntercomClient` constructor if you need a specific version.

## Subject routing

Episodes default to `customer:<id>`:

- If the conversation's contact has a primary company (first in `contact.companies`), the company id is used. Best for B2B SaaS where "the customer" is the account, not the individual reporter.
- If not, the contact id is used. Right fallback for B2C / single-tenant workspaces.
- Pathological conversations with no contact at all (rare; happens for app-only automation) fall back to `conversation:<id>` so episodes still group somewhere sensible.

Override per sync with `--subject account:acme` (or any string) when you want all conversations to land on a single subject.

## Permalinks

Pass `--app-id <workspace_id>` to mint browser permalinks like `https://app.intercom.com/a/inbox/<app_id>/inbox/conversation/<id>` on each episode's `source.url`. Without it, episodes don't carry a permalink — Intercom's REST API doesn't return one.

## Options

```
--access-token TOKEN   Intercom access token (required) — personal token or OAuth bearer
--region us|eu|au      workspace region (default: us)
--app-id ID            workspace id, for permalinks (optional)

--subject SUBJECT      override the default `customer:<id>` subject
--since YYYY-MM-DD     skip conversations whose updated_at is older
--max-items N          cap mapped episodes
--include LIST         allow-list — `conversations`, `parts` (default: conversations only)
--tags LIST            tag-name allowlist (case-sensitive). Drops conversations whose tags don't intersect with this list.
--teams LIST           team_assignee_id allowlist. Drops conversations not assigned to one of these teams.
--exclude LIST         deny-list (e.g. --exclude conversations to only fetch parts)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Webhook receiver (v0.2.0)

The same package also ships an Intercom webhook receiver — a pure `(Request) => Promise<Response>` handler that verifies Intercom's HMAC-SHA1 signature, dedups retries, maps the inbound payload, and ingests every conversation event in real time.

### Run it as a daemon

```bash
export INTERCOM_CLIENT_SECRET=...   # Intercom → Settings → Integrations → Developer Hub → your app → Authentication → Client secret
export INTERCOM_APP_ID=...          # for browser permalinks on emitted episodes
export INTERCOM_REGION=us           # us | eu | au (default us)
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen intercom --port 3000
# → http://0.0.0.0:3000/intercom/events
```

### Configure Intercom

In Intercom:

1. **Settings → Integrations → Developer Hub → your app → Webhooks**
2. **Endpoint URL**: your public webhook URL (e.g. `https://you.example.com/intercom/events` via ngrok / your own ingress)
3. **Topics**: subscribe to the topics the receiver dispatches on:
   - `conversation.user.created`
   - `conversation.user.replied`
   - `conversation.admin.replied`
   - `conversation.admin.noted`
   - `conversation.admin.closed`
4. Save. Intercom signs every delivery with the app's **Client secret** under `X-Hub-Signature: sha1=<hex>`. Set the same value as `INTERCOM_CLIENT_SECRET` on the daemon.

The receiver accepts (and 200-acks) other topics with `ignored: "unknown_topic"`, so subscribing to extras in Intercom won't 4xx the firehose — they just don't produce episodes yet.

### Episode kinds dispatched

| Webhook `topic` | Episode `kind` |
|---|---|
| `conversation.user.created` | `intercom.conversation.created` |
| `conversation.user.replied` | `intercom.conversation.replied` (latest user comment part) |
| `conversation.admin.replied` | `intercom.conversation.replied` (latest admin comment part) |
| `conversation.admin.noted` | `intercom.conversation.note_added` (latest admin note part) |
| `conversation.admin.closed` | `intercom.conversation.closed` |

Reply / note dispatch picks the most recent matching `part_type` (`comment` for replies, `note` for notes) from `data.item.conversation_parts.conversation_parts`. If none of the listed parts match, the receiver falls back to the last part of any kind so the event isn't silently swallowed.

### Or mount on Vercel / Cloudflare / Express

Same framework-agnostic shape as the Slack, Freshdesk, and Zendesk handlers:

```ts
import { createIntercomWebhookHandler } from '@statewavedev/connectors-intercom'

export const POST = createIntercomWebhookHandler({
  signingSecret: process.env.INTERCOM_CLIENT_SECRET!,
  appId: process.env.INTERCOM_APP_ID,
  region: 'us',
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
})
```

## Status

`v0.2.0` — pull mode for conversations + parts (with `--tags` and `--teams` allowlists) + webhook receiver. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.2 (planned for follow-ups):

- The Search Conversations API (richer server-side filtering for high-volume tenants — current pull walks `/conversations` with client-side `since` filter)
- Articles + Outbound message ingestion
- Per-author identity enrichment beyond the primary contact (would multiply API calls per webhook hit)
