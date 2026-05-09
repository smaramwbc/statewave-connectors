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
--since YYYY-MM-DD     skip tickets whose updated_at is older
--max-items N          cap mapped episodes
--include LIST         allow-list — `tickets`, `conversations` (default: tickets only)
--exclude LIST         deny-list (e.g. --exclude tickets to only fetch conversations)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Status

`v0.1.0` — pull mode for tickets + conversations. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned for follow-ups):

- The `updated_since` filter on the list endpoint (current pull walks tickets ordered by `created_at` with a client-side `since` filter)
- Solutions / KB articles ingestion
- Time entries + survey responses
- Webhook (push) mode — same daemon shape as Slack live-mode, queued for the next push-mode batch
