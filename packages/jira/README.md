# @statewavedev/connectors-jira

**Preview** Jira Cloud source connector for Statewave — turns Jira issues (and
optionally their comments) into normalized episodes under `project:<KEY>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. It ingests external Jira records **into** Statewave memory; it is not a Statewave storage backend.

## Install

```bash
# the connector + the unified CLI to run it
npm install -g @statewavedev/connectors-cli
npm install @statewavedev/connectors-jira
```

The CLI (`statewave-connectors`) discovers the connector by name (`sync jira`). You can also import `createJiraConnector` from `@statewavedev/connectors-jira` directly in your own code.

## Scope (preview)

- **Jira Cloud REST v3 only** — no Jira Server / Data Center.
- **API-token basic auth** (account email + API token).
- **Pull mode + a real-time webhook receiver** (`listen jira`) — see [Webhook receiver](#webhook-receiver-listen-jira).
- **Read-only** — issues and, opt-in, comments. Never writes to Jira.
- Project **allowlist required** in pull mode (optional, recommended in webhook mode) — a connector instance only ingests the projects you name.
- **No email addresses** — users are recorded by display name / accountId.

## What it ingests

| Source | Episode `kind` |
|---|---|
| Issue (open) | `jira.issue.created` |
| Issue (status category "done") | `jira.issue.resolved` |
| Comment (opt-in via `--include comments`) | `jira.comment.created` |

Each episode carries `source.url` (a `/browse/<KEY>` link) for provenance, plus
`status`, `labels`, `assignee`/`reporter` (display names), and timestamps in
`metadata`.

## Quickstart

```bash
export JIRA_EMAIL="you@example.com"
export JIRA_API_TOKEN="…"           # https://id.atlassian.com/manage-profile/security/api-tokens

statewave-connectors sync jira \
  --host https://myorg.atlassian.net \
  --projects ENG,PLATFORM \
  --dry-run
```

Add comments and redact PII from free text:

```bash
statewave-connectors sync jira \
  --host https://myorg.atlassian.net \
  --projects ENG \
  --include issues,comments \
  --redact-email --redact-phone --redact-secrets \
  --dry-run
```

`--dry-run` maps and prints episodes without ingesting. To **actually ingest**, drop `--dry-run` and point at your Statewave instance:

```bash
export STATEWAVE_URL="http://localhost:8100"
export STATEWAVE_API_KEY="…"   # if your instance requires one

statewave-connectors sync jira \
  --host https://myorg.atlassian.net \
  --projects ENG \
  --since 2026-01-01
```

## Webhook receiver (`listen jira`)

For real-time updates instead of (or alongside) polling, run the receiver — a
pure `(Request) => Promise<Response>` handler, mountable on the built-in daemon,
Vercel, Cloudflare, or Express. It dispatches the **same `jira.*` kinds** as the
pull connector.

```bash
export JIRA_WEBHOOK_SECRET="…"          # the secret you set on the Jira admin webhook
export JIRA_BASE_URL="https://myorg.atlassian.net"
export STATEWAVE_URL="http://localhost:8100"
export STATEWAVE_API_KEY="…"

statewave-connectors listen jira --port 3000 --projects ENG,PLATFORM
# → http://0.0.0.0:3000/jira/events
```

Then register a **Jira admin webhook** (Jira Settings → System → Webhooks, or
`POST /rest/webhooks/1.0/webhook`) pointing at the public address, **set its
secret to the same value**, and subscribe to the issue/comment events. Expose
the daemon publicly with a tunnel (ngrok / Cloudflare Tunnel) or your ingress.

**Authentication — verified, not assumed.** Jira admin webhooks sign every
callback: they compute an HMAC over the raw body using your secret and send it
as `X-Hub-Signature: sha256=<hex>`
([Atlassian docs](https://developer.atlassian.com/cloud/jira/platform/webhooks/)).
The receiver recomputes that MAC with HMAC-SHA256 and rejects any mismatch in
constant time **before** parsing or ingesting — there is no unauthenticated code
path. It then dedups Jira's at-least-once retries, applies the optional
`--projects` allowlist, normalizes with the same ADF→text / no-email path the
pull connector uses, and ingests.

| Inbound `webhookEvent` | Episode `kind` |
|---|---|
| `jira:issue_created`, `jira:issue_updated` (open) | `jira.issue.created` |
| `jira:issue_updated` (status category "done") | `jira.issue.resolved` |
| `comment_created`, `comment_updated` | `jira.comment.created` |

`jira:issue_deleted` / `comment_deleted` and unrecognized events are acked
(HTTP 200) and skipped — there is no delete episode kind.

Programmatic use:

```ts
import { createJiraWebhookHandler } from "@statewavedev/connectors-jira";

const handler = createJiraWebhookHandler({
  signingSecret: process.env.JIRA_WEBHOOK_SECRET!,
  baseUrl: "https://myorg.atlassian.net",
  projects: ["ENG"],            // optional allowlist
  redaction: { email: true },   // optional, parity with pull mode
  statewaveUrl: process.env.STATEWAVE_URL!,
  statewaveApiKey: process.env.STATEWAVE_API_KEY,
});
// export default handler;  // Vercel / Cloudflare
```

## Subject strategy

Each issue/comment lands under **`project:<KEY>`** (e.g. `project:ENG`) — the project the issue belongs to, so an agent can ask about a project's history. Override with `--subject <value>` to pin every episode to one subject instead.

## Example episode

```json
{
  "subject": "project:ENG",
  "kind": "jira.issue.resolved",
  "text": "Ada L resolved issue ENG-128: Login fails on Safari\n\nUsers on Safari 17 hit a redirect loop after SSO.",
  "occurred_at": "2026-05-20T14:03:00.000Z",
  "source": {
    "type": "jira.issue",
    "id": "ENG-128",
    "url": "https://myorg.atlassian.net/browse/ENG-128"
  },
  "metadata": {
    "issue_key": "ENG-128",
    "project_key": "ENG",
    "status": "Done",
    "status_category": "done",
    "issue_type": "Bug",
    "priority": "High",
    "labels": ["auth", "safari"],
    "assignee": "Ada L",
    "reporter": "Bob R",
    "related_subjects": ["issue:ENG-128", "assignee:Ada L"]
  },
  "idempotency_key": "…"
}
```

To get this exact shape, run the quickstart above with `--dry-run --json`.

## Status

**Preview**, Jira Cloud only. Pull mode **plus** a webhook receiver
(`listen jira`) with verified `X-Hub-Signature` HMAC-SHA256. Jira Server / Data
Center support is not yet included.
