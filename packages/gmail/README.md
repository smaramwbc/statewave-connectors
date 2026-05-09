# @statewavedev/connectors-gmail

Gmail connector for Statewave — turns messages matching an operator-supplied Gmail search query into normalized relationship-memory episodes.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Inbound message (no `SENT` label) | `gmail.message.received` |
| Outbound message (`SENT` label present) | `gmail.message.sent` |

The `--query` flag is **required** — there is no "ingest the whole mailbox" default. You scope what to pull explicitly.

## Quickstart

```bash
export GMAIL_CLIENT_ID=...
export GMAIL_CLIENT_SECRET=...
export GMAIL_REFRESH_TOKEN=...

statewave-connectors sync gmail \
  --query 'label:inbox newer_than:30d' \
  --dry-run

# Per-contact pull
statewave-connectors sync gmail \
  --query 'from:foo@bar.com after:2026/01/01' \
  --max-items 50 \
  --dry-run
```

## Auth

OAuth 2.0 refresh-token flow. The connector accepts three credentials and exchanges them for a short-lived access token at runtime:

| Env var | CLI flag | What it is |
|---|---|---|
| `GMAIL_CLIENT_ID` | `--client-id` | OAuth 2.0 client id from your Google Cloud project |
| `GMAIL_CLIENT_SECRET` | `--client-secret` | OAuth 2.0 client secret |
| `GMAIL_REFRESH_TOKEN` | `--refresh-token` | Long-lived refresh token issued during the one-time consent flow |

The access token is cached until ~1 minute before expiry and refreshed transparently — there's no per-request OAuth round-trip.

### One-time setup

1. **Create an OAuth client** in [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → **Create Credentials** → **OAuth client ID** → **Desktop app** (or **Web application** with `http://localhost` as a redirect URI). Copy the client id + secret.
2. **Enable the Gmail API** under APIs & Services → Library → Gmail API → Enable.
3. **Run a one-time consent flow** with scope `https://www.googleapis.com/auth/gmail.readonly`. The simplest path is the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) → gear icon → check "Use your own OAuth credentials" → paste your client id/secret → in the left rail, find **Gmail API v1** → check `https://www.googleapis.com/auth/gmail.readonly` → **Authorize APIs** → after consent, **Exchange authorization code for tokens** → copy the `Refresh token`.
4. Export the three credentials and run the connector.

The refresh token is valid until you revoke it (in Google Account → Security → Third-party apps with account access). The access token is short-lived (~1 hour) and is never persisted by the connector.

Service-account auth with domain-wide delegation (for Workspace admins reading mailboxes across a domain) is queued for v0.1.1 — it requires JWT signing.

The credentials are used **only** by this connector and **only** sent to `https://oauth2.googleapis.com` (token exchange) and `https://gmail.googleapis.com` (Gmail API).

## Subject routing

Episodes default to `relationship:<other_email>`:

- For **received** messages, the "other party" is the From address.
- For **sent** messages, the "other party" is the first To recipient.
- Both are lowercased and stripped of any display name (`Bob <bob@x>` and `bob@x` route to the same `relationship:bob@x` subject).
- Pathological messages with no From and no To (rare — system-only mail) fall back to `thread:<thread_id>` so episodes still group coherently.

Override per sync with `--subject thread:<id>` or any custom string.

## Body extraction

Gmail returns email bodies as base64url-encoded MIME parts. The connector walks the MIME tree and extracts plaintext in this preference order:

1. **`text/plain`** part — used as-is
2. **`text/html`** part — tags stripped, `&entity;` references decoded
3. **Snippet fallback** — Gmail's server-side first-200-chars snippet

Bodies are truncated at **8000 characters** with an ellipsis marker so a single huge email doesn't dominate context bundles.

## Options

```
--client-id ID         OAuth 2.0 client id (required)
--client-secret SECRET OAuth 2.0 client secret (required)
--refresh-token TOKEN  OAuth 2.0 refresh token (required)
--query Q              Gmail search query (required) — e.g. 'label:inbox', 'from:foo@bar.com after:2026/01/01'
--label-ids LIST       (v0.1.1) typed label-id allowlist pushed to Gmail's `labelIds=` server-side filter (AND semantics; e.g. INBOX,IMPORTANT). Use Gmail's stable label ids when you want a typed filter rather than encoding label names into `--query`.
--cursor TOKEN         (v0.1.2 — global flag, also honored here) opaque historyId returned on the previous run's `summary.cursor`. When set, the sync uses Gmail's History API to fetch only what's new since. Falls back to a cold-start re-pull when the historyId is older than ~7 days (Gmail's history retention window).

--subject SUBJECT      override the default `relationship:<email>` subject
--since YYYY-MM-DD     skip messages whose internalDate is older (belt-and-suspenders — Gmail's `after:` operator is usually the right primitive)
--max-items N          cap mapped episodes
--dry-run              preview mapped episodes without ingesting (recommended for new use)
```

## Status

`v0.1.2` — pull mode for messages matching a Gmail query, with optional typed `--label-ids` server-side filter and (v0.1.2) Gmail History API delta sync via `--cursor`. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.1 (planned for follow-ups):

- Service account / domain-wide delegation auth (needs JWT signing)
- _(landed in v0.1.2)_ ~~The History API for delta sync~~ — `--cursor <historyId>` now uses Gmail's History API to pull only what's new; cold-start runs capture the latest historyId so callers can persist it for the next run.
- Thread-level episodes (today each message is its own episode; threads are grouped via `metadata.thread_id`)
- Attachment metadata extraction
- Webhook (push) mode via Gmail Pub/Sub watch — same daemon shape as Slack live-mode
