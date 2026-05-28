# @statewavedev/connectors-freshdesk

Freshdesk connector for Statewave — turns support tickets and conversation entries into normalized episodes scoped to the customer (company or requester).

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Ticket created (subject + first body) | `freshdesk.ticket.created` |
| Ticket marked resolved or closed | `freshdesk.ticket.resolved` |
| Public reply on a ticket | `freshdesk.conversation.posted` |
| Private agent note on a ticket | `freshdesk.conversation.internal_note` |

Conversations are off by default — pass `--include tickets,conversations` to also walk every ticket's conversation thread (one extra API call per ticket).

## Example episode

```json
{
  "subject": "customer:6001",
  "kind": "freshdesk.ticket.created",
  "text": "Cannot reset password\n\nThe reset email never arrives.",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "freshdesk.ticket", "id": "ticket:4821", "url": "https://acme.freshdesk.com/a/tickets/4821" }
}
```

Run `statewave-connectors sync freshdesk --subdomain acme --api-key … --dry-run --json` to see this exact shape (including per-event `metadata`).

## Quickstart

```bash
export FRESHDESK_SUBDOMAIN=acme
export FRESHDESK_API_KEY=...
statewave-connectors sync freshdesk --since 2026-01-01 --dry-run
```

## Auth

API key via HTTP Basic auth. Freshdesk's quirk: the password is literally the string `X` — the API key sits in the username slot, with `X` as the password. The connector handles that for you; just provide the key.

To find your API key: in the Freshdesk UI, click your profile avatar → **Profile settings** → look for "Your API Key" in the right-hand rail. Copy it as-is.

OAuth is intentionally not supported — Freshdesk's OAuth surface is built for end-user apps and doesn't carry a meaningful advantage over an API key for a server-side connector. The token is used **only** by this connector and **only** sent to `https://<subdomain>.freshdesk.com`.

## Subject routing

Episodes default to `customer:<id>`:

- If the ticket has a `company_id` (B2B account), the company id is used. This matches how support agents think — "show me Acme's history".
- If not, the requester id is used. Right fallback for B2C / single-tenant Freshdesk.
- Pathological tickets with neither (rare) fall back to `ticket:<id>` so episodes still group somewhere sensible.

Override per sync with `--subject account:acme` (or any string) when you want all tickets to land on a single subject.

## Status normalization

Freshdesk uses numeric status codes on the wire. The connector normalizes them to typed strings for episode metadata so operators don't have to memorize the table:

| Code | `ticket_status` |
|---|---|
| 2 | `open` |
| 3 | `pending` |
| 4 | `resolved` |
| 5 | `closed` |
| 6 | `waiting_on_customer` |
| 7 | `waiting_on_third_party` |
| anything else | `custom` |

The raw integer is preserved as `ticket_status_code` in metadata, so operators with custom statuses can still route on it.

## Options

```
--subdomain SUB        freshdesk subdomain (acme for https://acme.freshdesk.com) — required
--api-key KEY          freshdesk API key from profile settings — required

--subject SUBJECT      override the default `customer:<id>` subject
--since YYYY-MM-DD     skip tickets whose updated_at is older. Pushed server-side via Freshdesk's native `updated_since` query parameter (v0.1.1) — drops the work to "tickets that actually changed" rather than walking the whole list and dropping older entries client-side.
--max-items N          cap mapped episodes
--include LIST         allow-list — `tickets`, `conversations` (default: tickets only)
--exclude LIST         deny-list (e.g. --exclude tickets to only fetch conversations)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Webhook receiver (v0.2.0)

The same package also ships a Freshdesk webhook receiver — a pure `(Request) => Promise<Response>` handler that verifies a shared-secret header, dedups retries, maps the inbound payload, and ingests every ticket / conversation event in real time.

### Run it as a daemon

```bash
export FRESHDESK_WEBHOOK_SECRET=...    # shared secret (any random string)
export FRESHDESK_SUBDOMAIN=acme        # for browser permalinks on emitted episodes
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen freshdesk --port 3000
# → http://0.0.0.0:3000/freshdesk/events
```

### Configure Freshdesk

Freshdesk webhooks are configured per-Automation. In Freshdesk Admin:

1. **Admin → Workflows → Automations** → pick or create a rule (e.g. "Ticket created", "Ticket resolved", "New comment added")
2. **Action**: Trigger Webhook
3. **Request type**: POST
4. **Callback URL**: your public webhook URL (e.g. `https://you.example.com/freshdesk/events` via ngrok / your own ingress)
5. **Custom Headers**: add `X-Statewave-Token: <FRESHDESK_WEBHOOK_SECRET>` (matches the env var)
6. **Encoding**: JSON
7. **Content** (Liquid template — paste this for ticket events):

   ```json
   {
     "event": "ticket.created",
     "event_id": "fd_{{ticket.id}}_{{ticket.updated_at}}",
     "ticket": {
       "id": {{ticket.id}},
       "subject": {{ticket.subject | json}},
       "description_text": {{ticket.description_text | json}},
       "status": {{ticket.status}},
       "priority": {{ticket.priority}},
       "type": {{ticket.type | json}},
       "tags": {{ticket.tags | json}},
       "requester_id": {{ticket.requester_id}},
       "responder_id": {{ticket.responder_id}},
       "company_id": {{ticket.company_id}},
       "group_id": {{ticket.group_id}},
       "product_id": {{ticket.product_id}},
       "brand_id": {{ticket.brand_id}},
       "created_at": {{ticket.created_at | json}},
       "updated_at": {{ticket.updated_at | json}}
     }
   }
   ```

8. For comment-added rules, append a `comment` block:

   ```json
   "comment": {
     "id": {{conversation.id}},
     "private": {{conversation.private}},
     "body_text": {{conversation.body_text | json}},
     "user_id": {{conversation.user_id}},
     "source": {{conversation.source}},
     "created_at": {{conversation.created_at | json}}
   }
   ```

   …and set `"event": "comment.added"`.

### Episode kinds dispatched

| Webhook `event` | Episode `kind` |
|---|---|
| `ticket.created` | `freshdesk.ticket.created` |
| `ticket.resolved` (or `ticket.updated` with status 4/5) | `freshdesk.ticket.resolved` |
| `ticket.updated` (other statuses) | `freshdesk.ticket.created` (idempotency-safe re-emission) |
| `comment.added` (`private: false`) | `freshdesk.conversation.posted` |
| `comment.added` (`private: true`) | `freshdesk.conversation.internal_note` |

### Or mount on Vercel / Cloudflare / Express

Same framework-agnostic shape as the Slack handler:

```ts
import { createFreshdeskWebhookHandler } from '@statewavedev/connectors-freshdesk'

export const POST = createFreshdeskWebhookHandler({
  signingSecret: process.env.FRESHDESK_WEBHOOK_SECRET!,
  subdomain: 'acme',
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
})
```

## Status

`v0.2.0` — pull mode for tickets + conversations (with native `updated_since` server-side filter) + webhook receiver. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.2 (planned for follow-ups):

- Solutions / KB articles ingestion
- Time entries + survey responses
- Per-author identity enrichment beyond the requester id surfaced on the webhook payload
