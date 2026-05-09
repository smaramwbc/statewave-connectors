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
--exclude LIST         deny-list (e.g. --exclude tickets to only fetch comments)
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Status

`v0.1.1` — pull mode for tickets + comments, with `--brands` + `--statuses` allowlists. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned for follow-ups):

- Incremental Tickets Export API (the right primitive for ongoing high-volume sync; current pull walks `/api/v2/tickets.json` ordered by `created_at`)
- Macros applied (signal that a known playbook was used)
- Side conversations
- Per-author identity enrichment beyond the requester (saves N+1 lookups)
- Brand allowlist (`--brands LIST`)
