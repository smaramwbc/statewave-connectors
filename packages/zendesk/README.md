# @statewavedev/connectors-zendesk

Zendesk connector for Statewave — turns support tickets and comments into normalized episodes scoped to the customer (organization or requester).

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Ticket created (subject + description) | `zendesk.ticket.created` |
| Ticket marked solved or closed | `zendesk.ticket.solved` |
| Public reply on a ticket | `zendesk.comment.posted` |
| Internal note on a ticket | `zendesk.comment.internal_note` |

Comments are off by default — pass `--include tickets,comments` to also walk every ticket's comment thread (one extra API call per ticket).

## Example episode

```json
{
  "subject": "customer:6001",
  "kind": "zendesk.ticket.created",
  "text": "Cannot reset password\n\nThe reset email never arrives for this user.",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "zendesk.ticket", "id": "ticket:4821", "url": "https://acme.zendesk.com/agent/tickets/4821" }
}
```

Run `statewave-connectors sync zendesk --subdomain acme --dry-run --json` to see this exact shape (including per-event `metadata`).

## Quickstart

```bash
# API token mode (most common)
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_EMAIL=agent@acme.example
export ZENDESK_API_TOKEN=...
statewave-connectors sync zendesk --since 2026-01-01 --dry-run

# OAuth bearer mode (if you already have an issued access token)
export ZENDESK_SUBDOMAIN=acme
export ZENDESK_OAUTH_TOKEN=...
statewave-connectors sync zendesk --include tickets,comments --dry-run
```

## Auth

Two modes, auto-detected from env / CLI flags:

| Mode | Env vars | CLI flags | Header emitted |
|---|---|---|---|
| API token (most common) | `ZENDESK_EMAIL` + `ZENDESK_API_TOKEN` | `--email` + `--api-token` | `Basic base64("<email>/token:<api_token>")` |
| OAuth bearer | `ZENDESK_OAUTH_TOKEN` | `--oauth-token` | `Bearer <access_token>` |

If both are set, OAuth wins. The connector itself never runs the OAuth dance — operators who use OAuth bring their own already-issued access token (typically from a Zendesk app or admin OAuth flow). The token is used **only** by this connector and **only** sent to `https://<subdomain>.zendesk.com`.

To create an API token: Zendesk Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → add an API token. Pair it with the email of the agent the token belongs to.

## Subject routing

Episodes default to `customer:<id>`:

- If the ticket has an `organization_id` (B2B account), the org id is used. This matches how support agents think — "show me Acme's history".
- If not, the requester's user id is used. This is the natural fallback for B2C / single-tenant Zendesk.
- Pathological tickets with neither (rare) fall back to `ticket:<ticket_id>` so episodes still group somewhere sensible.

Override per sync with `--subject account:acme` (or any string) when you want all tickets to land on a single subject.

## Options

```
--subdomain SUB        zendesk subdomain (acme for https://acme.zendesk.com) — required
--email EMAIL          api_token mode — pairs with --api-token
--api-token TOKEN      api_token mode — pairs with --email
--oauth-token TOKEN    oauth mode — already-issued bearer token

--subject SUBJECT      override the default `customer:<id>` subject
--since YYYY-MM-DD     skip tickets whose updated_at is older
--max-items N          cap mapped episodes
--include LIST         allow-list — `tickets`, `comments` (default: tickets only)
--brands LIST          brand id allowlist (numeric ids, comma-separated). Drops tickets whose brand_id is not in the list. Useful for multi-brand accounts.
--statuses LIST        status allowlist — new,open,pending,hold,solved,closed. Drops tickets whose normalized status isn't in the list.
--use-incremental      (v0.1.2) bootstrap delta sync from the very first run via the Incremental Tickets Export API. After that, every run that passes `--cursor <prev>` walks the incremental endpoint regardless. Requires admin API access.
--cursor TOKEN         (v0.1.2 — global flag, also honored here) opaque cursor returned on the previous run's `summary.cursor`. When set, the sync pulls only tickets that changed since.
--exclude LIST         deny-list (e.g. --exclude tickets to only fetch comments)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Webhook receiver (v0.2.0)

The same package also ships a Zendesk webhook receiver — a pure `(Request) => Promise<Response>` handler that verifies Zendesk's HMAC-SHA256 signature, dedups retries, maps the inbound payload, and ingests every ticket / comment event in real time.

Two delivery shapes are accepted:

- **Trigger / Automation–driven** (most common today): operator writes a JSON body in the trigger action template with a top-level `event` discriminator.
- **Event-driven webhook subscription**: Zendesk's stable envelope, no Liquid template required (`type: "zen:event-type:ticket.created"`).

### Run it as a daemon

```bash
export ZENDESK_WEBHOOK_SIGNING_SECRET=...   # from Zendesk Admin → Apps and integrations → Webhooks → <webhook> → Signing secret
export ZENDESK_SUBDOMAIN=acme               # for browser permalinks on emitted episodes
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen zendesk --port 3000
# → http://0.0.0.0:3000/zendesk/events
```

### Configure Zendesk (trigger-driven)

In Zendesk Admin Center:

1. **Apps and integrations → Webhooks → Create webhook → Connect with a trigger or automation**
2. **Endpoint URL**: your public webhook URL (e.g. `https://you.example.com/zendesk/events` via ngrok / your own ingress)
3. **Request method**: POST. **Request format**: JSON. **Authentication**: None (the HMAC signature is the auth).
4. After creating the webhook, copy the **Signing secret** — that's the value you set as `ZENDESK_WEBHOOK_SIGNING_SECRET`.
5. Create a **Trigger** (or Automation) that fires on the events you care about (Ticket created, Status changed, Comment added, …) with the action **Notify active webhook** → pick the webhook you just made.
6. Set the **JSON body** to the canonical template. For ticket events:

   ```json
   {
     "event": "ticket.created",
     "event_id": "{{ticket.id}}_{{ticket.updated_at_with_timestamp}}",
     "ticket": {
       "id": {{ticket.id}},
       "subject": {{ticket.title | json}},
       "description": {{ticket.description | json}},
       "status": "{{ticket.status}}",
       "priority": "{{ticket.priority}}",
       "type": "{{ticket.ticket_type}}",
       "tags": {{ticket.tags | json}},
       "requester_id": {{ticket.requester.id}},
       "assignee_id": {{ticket.assignee.id}},
       "organization_id": {{ticket.organization.id}},
       "brand_id": {{ticket.brand.id}},
       "group_id": {{ticket.group.id}},
       "created_at": {{ticket.created_at_with_timestamp | json}},
       "updated_at": {{ticket.updated_at_with_timestamp | json}},
       "url": {{ticket.url | json}}
     }
   }
   ```

7. For comment-added triggers, append a `comment` block and set `"event": "comment.created"`:

   ```json
   "comment": {
     "id": {{ticket.latest_comment.id}},
     "public": {{ticket.latest_public_comment.is_public}},
     "body": {{ticket.latest_comment.value | json}},
     "author_id": {{ticket.latest_comment.author.id}},
     "created_at": {{ticket.latest_comment.created_at_with_timestamp | json}}
   }
   ```

### Configure Zendesk (event-driven)

If you'd rather not author Liquid templates, use **Apps and integrations → Webhooks → Create webhook → Subscribe to events** and pick the events you want (`zen:event-type:ticket.created`, `zen:event-type:comment.created`, etc.). Zendesk delivers a stable envelope and the receiver routes it identically.

### Episode kinds dispatched

| Webhook `event` | Episode `kind` |
|---|---|
| `ticket.created` | `zendesk.ticket.created` |
| `ticket.solved` (or `ticket.updated` with status `solved`/`closed`) | `zendesk.ticket.solved` |
| `ticket.updated` (other statuses) | `zendesk.ticket.created` (idempotency-safe re-emission) |
| `comment.created` (`public: true`) | `zendesk.comment.posted` |
| `comment.created` (`public: false`) | `zendesk.comment.internal_note` |

Event-driven types map analogously — `zen:event-type:ticket.created` → `zendesk.ticket.created`, `zen:event-type:ticket.status_changed` → routed by current status, `zen:event-type:comment.created` → public/private split.

### Or mount on Vercel / Cloudflare / Express

Same framework-agnostic shape as the Slack and Freshdesk handlers:

```ts
import { createZendeskWebhookHandler } from '@statewavedev/connectors-zendesk'

export const POST = createZendeskWebhookHandler({
  signingSecret: process.env.ZENDESK_WEBHOOK_SIGNING_SECRET!,
  subdomain: 'acme',
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
})
```

## Status

`v0.2.0` — pull mode for tickets + comments (with brands/statuses allowlists and Incremental Tickets Export delta sync) + webhook receiver. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.2 (planned for follow-ups):

- Macros applied (signal that a known playbook was used)
- Side conversations
- Per-author identity enrichment beyond the requester (saves N+1 lookups on webhook hits)
