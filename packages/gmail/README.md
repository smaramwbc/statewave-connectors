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

## Pub/Sub push receiver (v0.2.0)

The same package also ships a Gmail Pub/Sub push receiver — a pure `(Request) => Promise<Response>` handler that ingests Gmail's "your mailbox changed" notifications, walks the Gmail History API to fetch the actually-changed messages, and emits each as a `gmail.message.received` / `gmail.message.sent` episode in real time. Same handler shape as the Slack/Freshdesk/Zendesk/Intercom receivers.

### How Gmail's push model works

Gmail doesn't deliver event payloads directly. The flow is:

1. Operator creates a Cloud Pub/Sub topic + push subscription pointing at the daemon URL.
2. Operator calls `users.watch` on the Gmail API, registering the topic. Gmail returns `historyId` + `expiration` (max 7 days; renew via cron).
3. Whenever the mailbox changes, Gmail publishes `{ emailAddress, historyId }` to the topic.
4. Pub/Sub POSTs that pointer to the daemon URL.
5. The daemon walks `users.history.list?startHistoryId=<lastSeen>` to fetch the actual deltas, then `users.messages.get` for each new message id, and ingests each as an episode.

Cursor state (the last-seen historyId per mailbox) is persistent — the receiver ships an in-memory store by default and exposes a `GmailHistoryCursorStore` interface so production deploys can plug in Redis / Postgres.

### Run it as a daemon

```bash
export GMAIL_PUBSUB_TOKEN=...           # random secret you put in the Pub/Sub subscription URL
export GMAIL_CLIENT_ID=...               # same OAuth credentials the pull connector uses
export GMAIL_CLIENT_SECRET=...
export GMAIL_REFRESH_TOKEN=...
export GMAIL_QUERY='label:inbox'         # optional — same semantics as pull --query
export STATEWAVE_URL=http://localhost:8100
export STATEWAVE_API_KEY=...

statewave-connectors listen gmail --port 3000
# → http://0.0.0.0:3000/gmail/events
```

The daemon expects the path-token either as the last URL path segment (`/gmail/events/<token>`) or as a query-string parameter (`?token=<value>`) — both work and the Pub/Sub subscription can be configured either way.

### Configure Cloud Pub/Sub + Gmail watch

In the Google Cloud Console (using the same Google Cloud project that owns your Gmail OAuth client):

1. **Pub/Sub → Topics → Create topic** (e.g. `gmail-push`). Note the full resource name `projects/<project-id>/topics/gmail-push`.
2. **IAM**: grant `roles/pubsub.publisher` on the topic to `gmail-api-push@system.gserviceaccount.com` (Gmail's service account that publishes notifications).
3. **Pub/Sub → Subscriptions → Create subscription** on that topic. Pick **Push** as the delivery type and set the endpoint to:

   ```
   https://you.example.com/gmail/events?token=<GMAIL_PUBSUB_TOKEN>
   ```

   Use the same value as `GMAIL_PUBSUB_TOKEN` in the daemon.
4. **Register the watch** by calling `users.watch` on the Gmail API with the topic name. The simplest path is a one-line script:

   ```bash
   curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/watch \
     -H "Authorization: Bearer $GMAIL_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"topicName":"projects/<project-id>/topics/gmail-push","labelIds":["INBOX"]}'
   ```

   Re-run before the 7-day expiration to keep the watch alive (cron / scheduled function).

### Cursor + replay model

| State | Default | How to override |
|---|---|---|
| Last-seen historyId per mailbox | `InMemoryGmailHistoryCursorStore` (lost on restart — fine for single-process daemons) | Pass `historyCursorStore: ...` implementing `get/set` (Redis, Postgres, …) |
| Pub/Sub messageId dedup | `InMemoryGmailPubsubDedupCache` (FIFO, 10k entries) | Pass `dedupCache: ...` |

On **cold start** (no persisted historyId for that mailbox), the receiver acks 200 and persists the notification's historyId without ingesting anything — the operator is expected to seed history via a cold-start pull (`statewave-connectors sync gmail --query …`) before turning the daemon on.

When Gmail returns 404 on the History endpoint (cursor older than ~7 days), the receiver logs a warning, resets the cursor to the latest historyId, and acks 200 — the operator should re-run a cold-start pull to backfill the lost window.

### Or mount on Vercel / Cloudflare / Express

Same framework-agnostic shape as the other receivers:

```ts
import { createGmailPubsubHandler } from '@statewavedev/connectors-gmail'

export const POST = createGmailPubsubHandler({
  pathToken: process.env.GMAIL_PUBSUB_TOKEN!,
  credentials: {
    clientId: process.env.GMAIL_CLIENT_ID!,
    clientSecret: process.env.GMAIL_CLIENT_SECRET!,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN!,
  },
  query: 'label:inbox',
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
})
```

You can also plug `verifyAuth: (req) => Promise<boolean>` instead of (or alongside) the path-token to verify Pub/Sub's OIDC bearer token against Google's well-known JWKs — that's the production path when the operator wants Google-signed delivery proofs rather than a shared secret in the URL.

## Status

`v0.2.0` — pull mode for messages matching a Gmail query (with `--label-ids` server-side filter and History-API delta sync) + Pub/Sub push receiver. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).

Out of scope for v0.2 (planned for follow-ups):

- Service account / domain-wide delegation auth (needs JWT signing)
- Built-in OIDC verification of Pub/Sub push tokens (today: plug your own `verifyAuth` callback if you don't want path-token auth)
- Thread-level episodes (today each message is its own episode; threads are grouped via `metadata.thread_id`)
- Attachment metadata extraction
- A renew-watch helper that calls `users.watch` on a schedule (today: ship your own cron)
