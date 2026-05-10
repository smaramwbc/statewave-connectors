# Release Notes

## v0.12.0 — Operator/cloud productization Wave 1: config file (TOML, multi-instance)

First entry in the **operator/cloud productization** track that follows Tier 2. Today every connector daemon is a single-process Node process started by hand with env vars + flags; this wave lays the foundation for a `statewave-connectors run --config <path>` daemon (Wave 2) by shipping the config schema, loader, validator, and a `validate-config` CLI subcommand that runs as a static check (no network calls, no daemon).

**New package: `@statewavedev/connectors-config@0.1.0`**

| Surface | Detail |
|---|---|
| Format | TOML. Unambiguous, comment-friendly, stdlib-shaped — no YAML semantic surprises (norway problem, indentation, boolean coercions). Parser is `smol-toml` (zero deps, TOML 1.0 compliant). |
| Multi-instance from day one | Every connector kind is an array (`[[pull.github]]`, `[[push.slack]]`). Real adopters always have *some* second instance — two GitHub orgs, two Slack workspaces (prod + sandbox), two Zendesk subdomains (per region or per brand), an agency operating multiple clients. Single-instance would push them off the runner. Each entry must carry a `name` (matching `[a-z0-9][a-z0-9_-]*`) unique within its kind; the runner uses `(connector_kind, name)` to key cursor state and (for push) mount the receiver at `/<connector>/<name>/events`. The same `name` is allowed across different kinds. |
| Schedule strings | Pull entries require a `schedule` — either `every <N><s\|m\|h\|d>` (e.g. `every 15m`, `every 1h`) or 5-field POSIX cron (`0 */1 * * *`). This release validates the string shape; the runner (Wave 2) wires the actual scheduler. |
| Env-var interpolation | `${VAR}` (required), `${VAR:-fallback}` (optional, fallback used when var is unset OR empty), `$$` for a literal `$`. Walks every string in the parsed-TOML tree. Resolved against `process.env` at load time — secrets stay in env, no eval surface, no command substitution. |
| Fail-fast diagnostics | Missing-required env vars are collected across the whole tree and reported as a single `ConfigError({ code: 'missing_env', missing: [...] })` — operator sees the full list at once instead of edit-run-edit-run. Schema validation is the same: every issue across every entry comes back in one pass with a dotted path (`pull.github[0].repo`) and a human message. |
| Search order | `--config <path>` → `$STATEWAVE_CONNECTORS_CONFIG` → `./statewave-connectors.toml` → `$XDG_CONFIG_HOME/statewave-connectors/config.toml` (defaults to `~/.config`). First match wins. The loader returns which slot won so doctor / validate-config can report it. |
| Typed error model | `ConfigError` with `code: 'not_found' \| 'parse_error' \| 'missing_env' \| 'validation_error'`. Each carries the right shape of supplemental data (`searched`, `missing`, `issues`). |
| Public API | `loadConfig(options)` is the one-call entry point. Importable from `@statewavedev/connectors-config` so anyone (not just the CLI) can consume the same schema. |

**Schema covers all 11 connectors:**

- Pull: `github`, `markdown`, `slack`, `n8n`, `discord`, `zendesk`, `intercom`, `freshdesk`, `notion`, `gmail` (Zapier is push-only / helper, intentionally absent from `[[pull.*]]`)
- Push: `slack`, `freshdesk`, `zendesk`, `intercom`, `gmail` (the five Tier 2 receivers)

Connector-specific validation rules live alongside the schema — `gmail` requires `client_id` + `client_secret` + `refresh_token` + `query`; `zendesk` requires `subdomain` plus EITHER (`email` + `api_token`) OR `oauth_token`; `intercom` / `zendesk` push validate `region` against `us|eu|au`; `zendesk` push validates `replay_window_sec` is a positive integer.

**New CLI subcommand: `statewave-connectors validate-config [--config <path>] [--json]`**

Static check — parses the config, runs every validation, reports problems. No network calls; pair with `doctor` to also smoke-test the source-system credentials. Exit codes: `0` clean, `2` operator-fixable (not_found / missing_env / validation_error), `1` unexpected internal failure.

```
$ statewave-connectors validate-config --config ./statewave-connectors.toml
✓ config OK
  path:     ./statewave-connectors.toml
  source:   explicit
  statewave: http://localhost:8000
  pull:
    github/main-repo  (every 1h)
    github/second-repo  (0 */6 * * *)
    gmail/founder-inbox  (every 15m)
  push:
    slack/team-events  → /slack/team-events/events
    gmail/founder-pubsub  → /gmail/founder-pubsub/events
```

```
$ statewave-connectors validate-config
error: 3 env var(s) referenced in config but not set:
  - STATEWAVE_API_KEY
  - GITHUB_TOKEN
  - SLACK_SIGNING_SECRET
```

```
$ statewave-connectors validate-config --config ./bad.toml
error: 4 validation issue(s):
  - statewave.url: required string
  - pull.github[0].name: must match [a-z0-9][a-z0-9_-]*
  - pull.github[0].schedule: required string
  - pull.github[0].repo: required
```

**25 new tests** in `packages/config/tests/` cover env-interpolation (8 — required/fallback/escape/missing collection), search-paths (5 — explicit/env/cwd/xdg precedence), and end-to-end load-config (12 — multi-instance valid configs, every failure mode, duplicate-name detection, cross-kind name reuse, unknown connector rejection, zendesk auth-mode disjunction). **Two new CLI tests** for the help wiring. Repo-wide: **401 tests across 16 packages**, all green.

**What's queued (next waves on the operator/cloud track):**

2. Hosted runner (`statewave-connectors run --config <path>`) — schedules pulls, multiplexes push receivers, renews Gmail watches.
3. Persistent state adapters — file/Postgres/Redis cursor + dedup stores (today's `InMemory*` defaults are documented as pluggable but ship no production adapters).
4. Built-in OIDC verification for the Gmail Pub/Sub receiver.
5. Graceful shutdown + Prometheus metrics + `/healthz` `/readyz`.
6. Deployment recipes — Helm chart, Docker Compose, Fly.io / Railway.

## v0.11.0 — Gmail Pub/Sub push receiver (Tier 2 push receivers complete)

`@statewavedev/connectors-gmail` bumps to `0.2.0`. **Final entry in the Tier 2 push-receiver wave** — closes the loop with the only push surface that doesn't fit the synchronous-HTTP-webhook mould. Gmail's "watch" API publishes a `{ emailAddress, historyId }` pointer to a Cloud Pub/Sub topic; Pub/Sub's push subscription POSTs that pointer to the daemon, which then walks Gmail's History API to fetch the actually-changed messages and emit each as an episode in real time.

| Surface | Detail |
|---|---|
| New factory | `createGmailPubsubHandler({ pathToken, credentials, query?, labelIds?, ... })` |
| Auth model | **Path-token** (random secret in the Pub/Sub subscription URL — `https://you/gmail/events?token=<value>` or as the URL's last path segment). Constant-time compare. Operators who want Google-signed OIDC verification can plug a `verifyAuth: (req) => Promise<boolean>` callback that runs ahead of the path-token check; built-in OIDC verification is queued as a follow-up since it requires fetching + caching Google's JWKs. |
| Two-step ingestion | Pub/Sub delivers only the historyId pointer; the receiver then calls `users.history.list?startHistoryId=<lastSeen>` to enumerate the deltas, plus `users.messages.get` for each new id, to produce the same `gmail.message.received` / `gmail.message.sent` episodes pull mode emits. Same `--query` / `--label-ids` filtering applied client-side after fetch (mirrors pull semantics so the delta result-set stays scoped to the active filter). |
| Episode kinds dispatched | `gmail.message.received` (no `SENT` label), `gmail.message.sent` (`SENT` label present) — same shapes pull mode emits, classified by SENT-label presence |
| Subject routing | `relationship:<other_email>` (From for received, first To for sent — lowercased + display-name-stripped). Pathological mail with neither falls back to `thread:<thread_id>`. Override per-handler with `subject: "thread:abc"`. |
| Persistent cursor | `GmailHistoryCursorStore` — pluggable per-mailbox last-seen historyId. `InMemoryGmailHistoryCursorStore` ships by default; production deploys plug Redis / Postgres. Required across deliveries because Pub/Sub only carries the latest historyId, not the deltas. |
| Pub/Sub messageId dedup | Standard `seenOrMark` cache; `InMemoryGmailPubsubDedupCache` ships by default (FIFO, 10k entries). |
| Cold-start handling | First delivery for a new mailbox acks 200 + `cold_start: true` and persists the historyId without ingesting — operators seed history via the existing cold-start pull (`sync gmail --query …`) before turning the daemon on, so the receiver doesn't accidentally backfill years of mail. |
| Stale-cursor handling | When Gmail returns 404 on the History endpoint (cursor older than ~7 days, Gmail's history retention window), the receiver logs `cursor_too_old`, resets the cursor to the incoming historyId, and acks 200 — operators see this in logs and should re-run a cold-start pull to recover the lost window. |
| Delivery failure | Always 200 ack on history-walk failures and individual ingest failures so Pub/Sub doesn't retry-storm a transient downstream blip. Cursor advances past the *attempted* window so we don't get stuck in a retry loop on a poisoned message. |
| CLI | `statewave-connectors listen gmail --port 3000` (defaults to `/gmail/events`). Reads `GMAIL_PUBSUB_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_QUERY`, `STATEWAVE_URL`, `STATEWAVE_API_KEY` from env; supports `--path-token`, `--client-id`, `--client-secret`, `--refresh-token`, `--query`, `--label-ids`, `--max-items`, `--path`, `--port`, `--host` flags. |

16 new tests in `packages/gmail/tests/webhook.test.ts` cover: config validation (missing pathToken/verifyAuth, missing credentials/historyReader, missing ingest), auth (bad path-token, accepting the token in the URL path suffix, verifyAuth callback short-circuit), cold-start cursor persistence, normal walk-and-ingest with `query` + `labelIds`, stale-cursor reset on 404, history-walk-throws ack-200, partial-ingest-failure ack-200, missing `message.data` tolerance, malformed-payload 400, missing watch fields tolerance, Pub/Sub messageId dedup, and the `historyCursorStore` + `dedupCache` external-pluggability. Gmail package: 42 tests across 3 files. Repo-wide: **374 tests across 15 packages**, all green.

This closes the Tier 2 wave. **All five planned push receivers shipped**: Slack DM/MPIM (v0.7.0), Freshdesk (v0.8.0), Zendesk (v0.9.0), Intercom (v0.10.0), Gmail Pub/Sub (v0.11.0). Every connector that supports a push surface in its source system now has a real-time receiver alongside its pull connector — `statewave-connectors listen <connector>` is the unified daemon, the same `(Request) => Promise<Response>` factory mounts on Vercel / Cloudflare / Express identically across the lineup.

## v0.10.0 — Intercom webhook receiver (Tier 2 push receivers, cont.)

`@statewavedev/connectors-intercom` bumps to `0.2.0`. Fourth entry in the **Tier 2 push receivers** wave (after Slack v0.4.0, Freshdesk v0.2.0, and Zendesk v0.2.0). Adds a real-time webhook receiver alongside the existing pull-mode connector — same pure `(Request) => Promise<Response>` shape as the other three, mountable on the built-in `statewave-connectors listen intercom` daemon, Vercel, Cloudflare Workers, or any framework that hands you a fetch-style request.

| Surface | Detail |
|---|---|
| New factory | `createIntercomWebhookHandler({ signingSecret, appId?, region?, statewaveUrl, ... })` |
| Auth model | **HMAC-SHA1** over the raw body, presented in `X-Hub-Signature: sha1=<hex>`. The signing key is the Intercom app's **Client secret** (Settings → Integrations → Developer Hub → your app → Authentication). Constant-time compare; no timestamp header (Intercom doesn't include one), so dedup by envelope id is the protection against repeated deliveries. |
| Topics dispatched | `conversation.user.created`, `conversation.user.replied`, `conversation.admin.replied`, `conversation.admin.noted`, `conversation.admin.closed` — five mapping to the four pull-mode episode kinds. Other topics return 200 + `ignored: "unknown_topic"` so operators can subscribe broadly without 4xx-ing the firehose. |
| Episode kinds dispatched | `intercom.conversation.created`, `intercom.conversation.replied` (user *and* admin replies, picking the latest comment part), `intercom.conversation.note_added` (latest note part), `intercom.conversation.closed` |
| `replied` / `noted` part picking | Walks `data.item.conversation_parts.conversation_parts` newest-first, picks the latest `comment` (for replies) or `note` (for noted). Falls back to the last part of any kind so the event isn't silently swallowed. |
| Subject routing | `customer:<primary_company_id>` if the contact has one (B2B), else `customer:<contact_id>` (B2C), else `conversation:<id>` (pathological — no contact). Override per-handler with `subject: "account:acme"`. |
| Permalinks | Optional `appId` + `region` mint `https://app.<region>.intercom.com/a/inbox/<app_id>/inbox/conversation/<id>` URLs on the emitted episodes' `source.url`. |
| Dedup | By Intercom's stable envelope `id` (Intercom retries with the same id on non-2xx). Pluggable cache; `InMemoryIntercomDedupCache` ships by default (FIFO, 10k entries) and is exposed as `handler.dedupCache` for multi-process deploys. |
| Ingest failure | Always 200 ack on processing errors so Intercom doesn't retry-storm a transient downstream blip; ingest exceptions surface via the `logger` sink. |
| CLI | `statewave-connectors listen intercom --port 3000` (defaults to `/intercom/events`). Reads `INTERCOM_CLIENT_SECRET`, `INTERCOM_APP_ID`, `INTERCOM_REGION`, `STATEWAVE_URL`, `STATEWAVE_API_KEY` from env; supports `--signing-secret`, `--app-id`, `--region`, `--path`, `--port`, `--host` flags. |

16 new tests in `packages/intercom/tests/webhook.test.ts` cover: config validation (missing signingSecret / missing ingest), auth (missing-signature / bad-signature / custom-header acceptance), full topic dispatch (`conversation.user.created`, `conversation.user.replied`, `conversation.admin.replied`, `conversation.admin.noted`, `conversation.admin.closed`), latest-part picking with mixed `part_type`s, fallback when no matching part is present, unknown-topic tolerance, missing-envelope-fields tolerance, dedup by envelope id, ingest-failure-still-acks, and `dedupCache` external-pluggability. Intercom package: 37 tests across 3 files. Repo-wide: 358 tests across 15 packages, all green.

Last in the Tier 2 wave: Gmail Pub/Sub watch — its own focused arc since the Gmail push surface is fundamentally different from a synchronous HTTP webhook (Pub/Sub push subscriptions instead of direct delivery, plus the History API tail-walk).

## v0.9.0 — Zendesk webhook receiver (Tier 2 push receivers, cont.)

`@statewavedev/connectors-zendesk` bumps to `0.2.0`. Third entry in the **Tier 2 push receivers** wave (after Slack v0.4.0 and Freshdesk v0.2.0). Adds a real-time webhook receiver alongside the existing pull-mode connector — same pure `(Request) => Promise<Response>` shape as the other two, mountable on the built-in `statewave-connectors listen zendesk` daemon, Vercel, Cloudflare Workers, or any framework that hands you a fetch-style request.

| Surface | Detail |
|---|---|
| New factory | `createZendeskWebhookHandler({ signingSecret, subdomain?, statewaveUrl, ... })` |
| Auth model | **HMAC-SHA256** over `<timestamp> + <body>`, base64-encoded, presented in `X-Zendesk-Webhook-Signature` (Zendesk's native scheme — not a shared header secret like Freshdesk). Constant-time compare; replay-protection window default 300s on `X-Zendesk-Webhook-Signature-Timestamp`, configurable via `replayWindowSec`. |
| Two delivery shapes | Both accepted on the same endpoint: (1) **trigger / Automation–driven** payloads with operator-authored Liquid JSON templates and a top-level `event` discriminator (`ticket.created`, `ticket.updated`, `ticket.solved`, `comment.created`); (2) **event-driven webhook subscriptions** with Zendesk's stable envelope (`type: "zen:event-type:ticket.created"`, etc.). The receiver normalizes both into a single internal representation. |
| Episode kinds dispatched | `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted` (public reply), `zendesk.comment.internal_note` (private note) — same shapes pull mode emits |
| `ticket.updated` / `ticket.status_changed` routing | Status `solved` / `closed` → `zendesk.ticket.solved`; everything else → `zendesk.ticket.created` (idempotency-safe re-emission, dedup absorbs the duplicate when ticket id + updated_at hasn't changed) |
| Subject routing | `customer:<organization_id>` if the ticket has an org id (B2B); else `customer:<requester_id>` (B2C); else `ticket:<id>` (pathological). Override per-handler with `subject: "account:acme"` |
| Dedup | By payload `event_id` (trigger) or `id` (event-driven) when present, else synthesized from `zendesk:<ticket_id>:<updated_at>:<event>` (with `:comment:<id>` suffix for comment events). Pluggable cache; `InMemoryZendeskDedupCache` ships by default (FIFO, 10k entries) and is exposed as `handler.dedupCache` for multi-process deploys. |
| Ingest failure | Always 200 ack on processing errors so Zendesk doesn't retry-storm a transient downstream blip; ingest exceptions surface via the `logger` sink. |
| CLI | `statewave-connectors listen zendesk --port 3000` (defaults to `/zendesk/events`). Reads `ZENDESK_WEBHOOK_SIGNING_SECRET`, `ZENDESK_SUBDOMAIN`, `STATEWAVE_URL`, `STATEWAVE_API_KEY` from env; supports `--signing-secret`, `--subdomain`, `--replay-window-sec`, `--path`, `--port`, `--host` flags. |

22 new tests in `packages/zendesk/tests/webhook.test.ts` cover: config validation (missing signingSecret / missing ingest), auth (missing-signature / missing-timestamp / bad-signature / stale-timestamp / custom-header-name acceptance), trigger-driven dispatch (`ticket.created`, `ticket.solved`, `ticket.updated` → routed by status, public + private comments), event-driven dispatch (`zen:event-type:ticket.created`, `zen:event-type:comment.created`, `zen:event-type:ticket.status_changed`), unknown-event tolerance, missing-ticket payload tolerance, dedup (explicit `event_id` / event-driven `id` / synthesized fallback), ingest-failure-still-acks, and `dedupCache` external-pluggability. Zendesk package: 45 tests across 3 files. Repo-wide: 342 tests across 15 packages, all green.

Next in the Tier 2 wave: Intercom webhook receiver, then Gmail Pub/Sub watch — each its own focused arc.

## v0.8.0 — Freshdesk webhook receiver (Tier 2 push receivers, cont.)

`@statewavedev/connectors-freshdesk` bumps to `0.2.0`. Adds a real-time webhook receiver alongside the existing pull-mode connector — the same pure `(Request) => Promise<Response>` shape as the Slack handler, mountable on the built-in `statewave-connectors listen freshdesk` daemon, Vercel, Cloudflare Workers, or any framework that hands you a fetch-style request.

| Surface | Detail |
|---|---|
| New factory | `createFreshdeskWebhookHandler({ signingSecret, signingHeader?, subdomain?, statewaveUrl, ... })` |
| Auth model | Shared-secret header (default `X-Statewave-Token`). Freshdesk webhooks have no native HMAC, so the operator configures the secret in Freshdesk Admin → Workflows → Automations → Webhook → Custom Headers; the handler does a constant-time compare before processing. Custom header name supported via `signingHeader`. |
| Configurable in Freshdesk via | Admin → Workflows → Automations → action: Trigger Webhook. JSON encoding, with operator-supplied Liquid templates for ticket and comment payloads (full templates in the README). |
| Webhook events accepted | `ticket.created`, `ticket.updated`, `ticket.resolved`, `comment.added` |
| Episode kinds dispatched | `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted` (public reply), `freshdesk.conversation.internal_note` (private agent note) — same shapes as pull mode so episodes from both sources rehydrate identically |
| `ticket.updated` routing | Routes by current status code: 4 (resolved) / 5 (closed) → `freshdesk.ticket.resolved`; everything else → `freshdesk.ticket.created` (idempotency-safe re-emission, dedup absorbs the duplicate when ticket id + updated_at hasn't changed) |
| Subject routing | `customer:<company_id>` if the ticket has a `company_id` (B2B); else `customer:<requester_id>` (B2C); else `ticket:<id>` (pathological). Override per-handler with `subject: "account:acme"` |
| Dedup | By `event_id` from the payload when present, else synthesized from `freshdesk:<ticket_id>:<updated_at>:<event>` (with `:comment:<id>` suffix for comment events). Pluggable cache; `InMemoryFreshdeskDedupCache` ships by default (FIFO, 10k entries) and is exposed as `handler.dedupCache` so multi-process deploys can share state. |
| Ingest failure | Always 200 ack on processing errors so Freshdesk doesn't retry-storm a transient downstream blip; ingest exceptions surface via the `logger` sink. |
| CLI | `statewave-connectors listen freshdesk --port 3000` (defaults to `/freshdesk/events`). Reads `FRESHDESK_WEBHOOK_SECRET`, `FRESHDESK_SUBDOMAIN`, `STATEWAVE_URL`, `STATEWAVE_API_KEY` from env; supports `--signing-header`, `--signing-secret`, `--subdomain`, `--path`, `--port`, `--host` flags. |

16 new tests in `packages/freshdesk/tests/webhook.test.ts` cover: config validation (missing signingSecret / missing ingest), auth (missing header, wrong secret, custom-header-name acceptance), dispatch (`ticket.created`, `ticket.resolved`, `ticket.updated` → routed by status, public + private comments), unknown-event tolerance (200 + `ignored: "unknown_event"`), dedup (explicit `event_id` and synthesized fallback), `missing_ticket` payload tolerance, ingest-failure-still-acks, and `dedupCache` external-pluggability. Freshdesk package: 36 tests across 3 files. Repo-wide: 320 tests across 15 packages, all green.

Next in the Tier 2 wave: Zendesk, Intercom webhook receivers, then Gmail Pub/Sub watch — each its own focused arc.

## v0.7.0 — Slack DM + MPIM webhook dispatch (Tier 2 push receivers begin)

`@statewavedev/connectors-slack` bumps to `0.4.0`. First entry in the **Tier 2 push receivers** wave — extending the existing Events-API webhook handler to dispatch DM (`message.im`) and group-DM (`message.mpim`) events through the same kinds the pull connector already uses.

| Surface | Detail |
|---|---|
| New config flags | `acceptDms`, `acceptMpim` (both default `false`). When true, the corresponding `channel_type: "im"` / `"mpim"` events flow through the handler instead of being filtered out. |
| New CLI flags | `listen slack --accept-dms --accept-mpim` |
| Episode kinds dispatched | `slack.dm.message.posted`, `slack.dm.thread.replied`, `slack.mpim.message.posted`, `slack.mpim.thread.replied` (all already shipped in pull mode v0.3.1 + v0.3.2) |
| Subject routing | DMs: `dm:<other_user_id>` (Slack's Events API delivers the OTHER user as `event.user` since the bot doesn't see its own messages echoed back). MPIMs: `mpim:<channel_id>`. |
| Allowlist behavior | DM/MPIM events **bypass** the channel allowlist because the channel id is a synthetic `D…` / `G…` snowflake operators can't predict ahead of time. Gating is via the explicit `accept-*` flags instead. |
| Filter reasons | `dms_disabled`, `mpim_disabled` for filtered events when the corresponding flag is off |
| New scopes (Slack-app side) | `im:history` (for `message.im` subscription), `mpim:history` (for `message.mpim` subscription). Same privacy posture as pull-mode DMs/MPIMs — opt-in deliberately. |

7 new tests in `packages/slack/tests/webhook-dms-mpim.test.ts` cover: default-filtered DM/MPIM behavior, dispatch when flags are on, DM thread-reply routing, channel-allowlist bypass for DM/MPIM events, and a regression check that normal channel events still flow when the accept-* flags are off. Slack package: 70 tests across 9 files. Repo-wide: 304 tests across 15 packages, all green.

This is the first Tier 2 push-receiver release. Queued: Zendesk, Intercom, Freshdesk webhook receivers + Gmail Pub/Sub watch — each its own focused arc since each adds a new daemon with its own signature/dedup/retry surface.

## v0.6.0 — Connector polish: delta sync + database scoping

Three high-leverage features across the v0.4 connectors. Each bumps to `0.1.2`; bundled under one merge so reviewers can see the related changes together. The big-deal pattern is **cursor-based delta sync** — Zendesk and Gmail can now both run "only what changed since" pulls, dropping API budget for high-volume operators.

| Connector | Bump | What changed |
|---|---|---|
| `@statewavedev/connectors-zendesk` | `0.1.2` | **Incremental Tickets Export** delta sync. New `--use-incremental` flag bootstraps from sync #1; the global `--cursor <prev>` flag (already in `SyncOptions`) runs the delta endpoint on every run after that. The new cursor is surfaced on `summary.cursor` so callers can persist it. Cold-start path unchanged when neither flag is set. |
| `@statewavedev/connectors-gmail` | `0.1.2` | **History API** delta sync. `--cursor <historyId>` walks `users/me/history?startHistoryId=…` to fetch only what's new. Falls back to a cold-start re-pull when the historyId is older than ~7 days (Gmail's history retention window). Cold-start runs always capture the latest historyId so callers can persist it and switch to delta mode on the next run. The operator's `--query` is honored client-side on history-discovered messages so the delta result-set stays scoped to the active filter. |
| `@statewavedev/connectors-notion` | `0.1.2` | **Database scoping**. New `--databases <id1,id2>` allowlist scopes the pull to specific databases via `POST /v1/databases/{id}/query` instead of the workspace-wide `/v1/search` walk. Useful for "only the Decisions database" without ingesting every page the integration can see. Database rows flow through the existing `notion.page.created` / `notion.page.updated` mapping with `parent_type: "database_id"` in metadata. |

7 new tests (+1 notion + 2 zendesk + 4 gmail). Repo-wide test count: **297 across 15 packages**, all green.

The cursor-state plumbing landed via the existing `SyncOptions.cursor` input + `SyncResult.cursor` output — no contract change to `connectors-core`. CLI and per-package READMEs updated. The auto-create-GitHub-release step (added in #24) will mint the matching v0.6.0 release on publish.

## v0.5.1 — Tier 1 connector polish

Filter and allowlist additions across the v0.4 connectors. Each connector is bumped to v0.1.1 (matching the Tier 1 cohort number); the polish landed under one merge so the related changes can be reviewed together.

| Connector | Bump | What changed |
|---|---|---|
| `@statewavedev/connectors-zendesk` | `0.1.1` | New `--brands` (numeric brand-id allowlist) and `--statuses` (typed status allowlist: new/open/pending/hold/solved/closed). Tickets that fail either filter are dropped client-side; new `tickets_filtered_out` counter in sync details. |
| `@statewavedev/connectors-intercom` | `0.1.1` | New `--tags` (case-sensitive name allowlist) and `--teams` (`team_assignee_id` allowlist). Conversations that fail either filter are dropped; new `conversations_filtered_out` counter. |
| `@statewavedev/connectors-freshdesk` | `0.1.1` | `--since` now uses Freshdesk's native `updated_since` server-side filter — drops the API-budget cost from "walk all tickets, drop older client-side" to "fetch only tickets that actually changed". |
| `@statewavedev/connectors-notion` | `0.1.1` | New `notion.comment.posted` episode kind. `--include pages,comments` opts into page-level discussion comments via `/v1/comments?block_id=<page_id>`. Per-block inline comments deferred to v0.1.2. |
| `@statewavedev/connectors-gmail` | `0.1.1` | New `--label-ids` flag pushes typed Gmail label ids (INBOX, IMPORTANT, user-defined Label_xyz, …) to the `labelIds=` server-side filter (AND semantics). Cleaner than encoding label names into `--query`. The full History API delta-sync work is deferred to v0.1.2 — it requires cursor-state design beyond a Tier 1 polish. |

7 new tests added (2 zendesk + 2 intercom + 1 freshdesk + 1 notion + 1 gmail). Repo-wide test count: **290 across 15 packages**, all green.

## v0.5.0 — Slack MPIM (group DM) support

`@statewavedev/connectors-slack` bumps to `0.3.2`. Adds opt-in multi-party DM (group DM) ingestion via a new `--include-mpim` flag — completes the DM coverage that v0.3.1 started for 1:1 DMs.

| Surface | Detail |
|---|---|
| New flag | `--include-mpim` (mutually-or with `--channels` and `--include-dms`) |
| New kinds | `slack.mpim.message.posted`, `slack.mpim.thread.replied` |
| New scopes | `mpim:read` (discover group-DM conversations), `mpim:history` (read messages) |
| Subject routing | `mpim:<channel_id>` per group DM. MPIMs have no single "other party"; the channel id is Slack's stable identity for the group |
| Sync details | New `events_mpims` and `mpims_synced` counters |
| Episode text | "<author> (group DM): <text>" — distinguishable from DM rendering at a glance |

Same privacy posture as DMs: opt-in for a reason. In shared workspaces other participants in a group DM didn't necessarily consent to having their messages mirrored elsewhere.

6 new tests in `packages/slack/tests/sync-mpim.test.ts` cover: rejection when no scope is set, accept-with-mpim-only, MPIM ingestion with correct subject + kind routing, MPIM thread-reply routing, the "(group DM)" text rendering + `is_mpim` metadata flag, and a single mixed sync that pulls channels + DMs + MPIMs together with correct per-event subjects. Slack package: 63 tests across 8 files. Repo-wide: 283 tests across 15 packages, all green.

## v0.4.4 — Gmail connector (pull-mode)

`@statewavedev/connectors-gmail` ships at `0.1.0`. **Last connector in the v0.1 line — every placeholder is now real code.** Turns Gmail messages matching an operator-supplied search query into normalized relationship-memory episodes, scoped per counterparty.

| Surface | Detail |
|---|---|
| Episode kinds | `gmail.message.received` (no `SENT` label), `gmail.message.sent` (`SENT` label present) |
| Subject default | `relationship:<other_email>` — From for received, first To for sent (lowercased, display-name-stripped); falls back to `thread:<thread_id>` for system-only mail with no human counterparty |
| Auth | OAuth 2.0 refresh-token flow. Access token cached until ~1 min before expiry; transparent refresh on the next call. Service-account / domain-wide-delegation queued for v0.1.1 (needs JWT signing) |
| API surface | `POST oauth2.googleapis.com/token` (refresh exchange), `GET /gmail/v1/users/me/messages?q=…` (cursor pagination), `GET /gmail/v1/users/me/messages/{id}?format=full` (per message) |
| Required scope | `https://www.googleapis.com/auth/gmail.readonly` |
| Required scoping | `--query` flag — operator must scope the pull (`label:inbox`, `from:foo@bar after:2026/01/01`, etc.). No "ingest the whole mailbox" default. |
| Body extraction | `text/plain` MIME preferred, `text/html` fallback with tags stripped + entity decoding. Bodies truncated at 8000 chars with ellipsis marker so a single huge email can't dominate context bundles. |
| CLI | `sync gmail --client-id <…> --client-secret <…> --refresh-token <…> --query <gmail-search>` |
| Doctor | reports `GMAIL_AUTH` (a single line that goes red on partial config — all three credentials must be present together) |
| Test wiring | `cli test --connector gmail` |

21 new tests (12 mapper + 9 sync) covering: SENT-label classification, relationship subject derivation across received/sent and display-name vs bare-address shapes, MIME tree walking with text/plain preference and text/html fallback (with `<script>` content correctly dropped along with tags), the OAuth refresh-exchange request shape, Bearer header on Gmail API calls, 401 from Gmail (cache invalidated, friendly error) and 400 from the OAuth endpoint (invalid_grant). Repo-wide test count: **277 across 15 packages**, all green.

This closes the v0.1 connector matrix: **github, markdown, slack (with DMs + webhooks), n8n, zapier, discord, zendesk, intercom, freshdesk, notion, gmail** — plus mcp, cli, all (meta-package), and core. Every placeholder package is now real shipping code.

Out of scope for v0.1.0 (queued for follow-ups):

- Service account / domain-wide delegation auth (needs JWT signing)
- The History API for delta sync (currently each run re-pulls the full query result; idempotency keys keep ingestion safe)
- Thread-level episodes (today each message is its own episode; threads are grouped via `metadata.thread_id`)
- Attachment metadata extraction
- Webhook (push) mode via Gmail Pub/Sub watch

## v0.4.3 — Notion connector (pull-mode)

`@statewavedev/connectors-notion` ships at `0.1.0`. First connector in the docs/decision-memory class — turns Notion pages (and optionally their body content) into normalized episodes scoped to whatever organizational unit the operator cares about (a repo, project, team, or the default `workspace:notion`).

| Surface | Detail |
|---|---|
| Episode kinds | `notion.page.created` (when `created_time === last_edited_time`), `notion.page.updated` (everything else) |
| Subject default | `workspace:notion` — operator overrides via `--subject repo:owner/name` (or any string) for retrieval-shape control, since Notion has no natural customer-axis equivalent |
| Auth | Bearer (internal integration token **or** OAuth access token — same header shape as Intercom) |
| API surface | `POST /v1/search` filtered to pages (cursor pagination by `next_cursor`), `GET /v1/blocks/{id}/children` for body extraction |
| API version pin | `Notion-Version: 2022-06-28` (long-stable) |
| CLI | `sync notion [--api-token <token>] [--subject <s>] [--include pages,content]` |
| Doctor | reports `NOTION_API_TOKEN` |
| Test wiring | `cli test --connector notion` |

**Body content is off by default.** Pass `--include pages,content` to also walk every page's child blocks via `/v1/blocks/{id}/children` and render them to plaintext (one extra API call per page, plus pagination if the page has > 100 blocks). The most common block types are rendered with markdown-style prefixes:

| Block type | Rendered as |
|---|---|
| `paragraph` | plain text |
| `heading_1` / `heading_2` / `heading_3` | `# text` / `## text` / `### text` |
| `bulleted_list_item` / `numbered_list_item` | `- text` / `1. text` |
| `to_do` | `[ ] text` or `[x] text` |
| `quote` | `> text` |
| `code` | triple-backtick fenced block with language |

Other types (callouts, embeds, tables, columns, child databases, synced blocks) are dropped at the extractor — v0.1 keeps the surface small and predictable.

The connector requires the integration to be **shared with each page or database it should read** — Notion's permission model means it cannot see anything that hasn't been explicitly connected via the page's "Connections" menu (sharing a parent shares all children).

18 new tests (10 mapper + 8 sync) covering: page-vs-update classification on equal-timestamp boundary, default + custom subject routing, optional body content extraction with all supported block types (and confirmation that callouts/etc are dropped), Bearer + Notion-Version header shape, 401 → `auth_failed` translation, and `--since` filtering on `last_edited_time`. Repo-wide test count: **256 across 14 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- Database queries (treating a database as a typed row source rather than a page collection)
- Comment ingestion (`/v1/comments`)
- Property mapping into structured episode metadata (today only the title property is read; other typed columns are dropped)
- Tables, callouts, embeds, columns, synced blocks in body rendering
- Webhook (push) mode — Notion's outbound webhooks are still in private beta on API version `2022-06-28`

## v0.4.2 — Freshdesk connector (pull-mode)

`@statewavedev/connectors-freshdesk` ships at `0.1.0`. Third connector in the support-tools class — turns Freshdesk tickets and conversation entries into normalized episodes scoped to the customer (company or requester). Fully clears the public "Customer memory" promise on `/connectors`.

| Surface | Detail |
|---|---|
| Episode kinds | `freshdesk.ticket.created`, `freshdesk.ticket.resolved`, `freshdesk.conversation.posted`, `freshdesk.conversation.internal_note` |
| Subject default | `customer:<company_id>` when set, else `customer:<requester_id>` (B2C / single-tenant fallback) |
| Auth | API key via HTTP Basic auth (Freshdesk's quirk: password is literally the string `X`, with the API key in the username slot — the connector handles that for you) |
| API surface | `GET /agents/me`, `GET /tickets` (page-number pagination), `GET /tickets/{id}/conversations`, `GET /contacts/{id}` (best-effort enrichment), `GET /companies/{id}` |
| Status normalization | Numeric codes (2=Open, 3=Pending, 4=Resolved, 5=Closed, 6=Waiting on Customer, 7=Waiting on Third Party) normalized to typed strings; raw code preserved as `ticket_status_code` for routing on custom statuses |
| Channel labels | `source` integer mapped to readable labels (`email`, `portal`, `phone`, `chat`, `mobihelp`, `feedback_widget`, `outbound_email`, `ecommerce`, fallback `source:<n>`) |
| CLI | `sync freshdesk --subdomain <acme> [--api-key <key>] [--include tickets,conversations]` |
| Doctor | reports `FRESHDESK_SUBDOMAIN` + `FRESHDESK_API_KEY` |
| Test wiring | `cli test --connector freshdesk` |

**Conversations are off by default.** Pass `--include tickets,conversations` to walk every ticket's conversation thread (one extra API call per ticket — same gating as Zendesk and Intercom). Private agent notes route to a separate `freshdesk.conversation.internal_note` kind so consumers can filter on visibility without re-deriving it from metadata.

19 new tests (11 mapper + 8 sync) covering: subject routing across company/requester/ticket axes, ticket/resolved/conversation kind routing, public vs internal note discrimination, the Basic auth `<api_key>:X` shape, channel label mapping (including unknown source codes), 401 → `auth_failed` translation, and status code normalization. Repo-wide test count: **238 across 13 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- The `updated_since` filter on `GET /tickets` (the right primitive for ongoing high-volume sync)
- Solutions / KB articles ingestion
- Time entries + survey responses
- Webhook (push) mode

## v0.4.1 — Intercom connector (pull-mode)

`@statewavedev/connectors-intercom` ships at `0.1.0`. Second connector in the support-tools class — turns Intercom conversations and conversation-parts into normalized episodes scoped to the customer (primary company or contact). Closes the second half of the public "Customer memory" promise on `/connectors`.

| Surface | Detail |
|---|---|
| Episode kinds | `intercom.conversation.created`, `intercom.conversation.closed`, `intercom.conversation.replied`, `intercom.conversation.note_added` |
| Subject default | `customer:<primary_company_id>` (first company on the contact) when set, else `customer:<contact_id>` |
| Auth | Bearer (personal access token **or** OAuth access token — same header shape) |
| Regions | US (default), EU, AU — picks the right `api.<region>.intercom.io` edge so EU/AU operators don't accidentally hit US infra |
| API surface | `GET /me`, `GET /conversations` (cursor pagination), `GET /conversations/{id}?display_as=plaintext`, `GET /contacts/{id}`, `GET /companies/{id}` (best-effort enrichment) |
| API version pin | `Intercom-Version: 2.13` |
| CLI | `sync intercom [--region us\|eu\|au] [--app-id <id>] [--include conversations,parts]` |
| Doctor | reports `INTERCOM_ACCESS_TOKEN` (with region) |
| Test wiring | `cli test --connector intercom` |

**Conversation parts are off by default.** Pass `--include conversations,parts` to also walk every conversation's part stream (one extra API call per conversation). System parts (assignment, close, snooze, away_mode, …) are dropped at the mapper — only "comment" (replies) and "note" (admin internal notes) become episodes. Notes route to a separate `intercom.conversation.note_added` kind so consumers can filter on visibility without re-deriving it from metadata.

19 new tests (10 mapper + 9 sync) covering: subject routing across primary-company / contact / conversation axes, conversation/closed/reply/note kind routing, public vs internal note discrimination, the Bearer + Intercom-Version header shape, regional routing (`api.eu.intercom.io`), and 401 → `auth_failed` translation. Repo-wide test count: **219 across 12 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- The Search Conversations API for richer server-side filtering
- Tag/team allowlist (`--tags`, `--teams`)
- Articles + Outbound message ingestion
- Webhook (push) mode — same daemon shape as Slack live-mode

## v0.4.0 — Zendesk connector (pull-mode)

`@statewavedev/connectors-zendesk` ships at `0.1.0`. First connector in the support-tools class — turns Zendesk tickets and comments into normalized episodes scoped to the customer (organization or requester) so support-agent workflows have per-account memory of what's broken, what's already been said, and what's still open.

| Surface | Detail |
|---|---|
| Episode kinds | `zendesk.ticket.created`, `zendesk.ticket.solved`, `zendesk.comment.posted`, `zendesk.comment.internal_note` |
| Subject default | `customer:<organization_id>` when set, else `customer:<requester_id>` (B2C / single-tenant fallback) |
| Auth | API token (Basic) **or** OAuth bearer — auto-detected from env / CLI flags. The connector never runs the OAuth dance; operators bring their own access token. |
| API surface | `GET /users/me`, `GET /tickets.json` (cursor pagination), `GET /tickets/{id}/comments.json`, `GET /organizations/show_many.json` (best-effort enrichment) |
| CLI | `sync zendesk --subdomain <acme> [--include tickets,comments]` |
| Doctor | reports `ZENDESK_SUBDOMAIN` + `ZENDESK_AUTH` (oauth bearer takes precedence over api_token) |
| Test wiring | `cli test --connector zendesk` |

**Comments are off by default.** Pass `--include tickets,comments` to also walk every ticket's comment thread (one extra API call per ticket — gated to keep the per-sync API budget bounded). Public comments map to `zendesk.comment.posted`; internal notes map to a separate `zendesk.comment.internal_note` kind so consumers can route on visibility without re-deriving it from metadata.

19 new tests (10 mapper + 9 sync) covering: subject routing across both org/requester axes, ticket/solved/comment kind routing, public vs internal note discrimination, both auth header shapes, and 401 → `auth_failed` translation. Repo-wide test count: **200 across 11 packages**, all green.

Out of scope for v0.1.0 (queued for follow-ups):

- Incremental Tickets Export API (the right primitive for high-volume ongoing sync)
- Macros applied as a signal episode kind
- Side conversations
- Brand allowlist (`--brands`)
- Per-author identity enrichment beyond the requester (saves N+1 lookups)

## v0.3.1 — Slack DM ingestion (pull)

`@statewavedev/connectors-slack` bumps to `0.3.1`. Adds opt-in DM ingestion to the pull-mode connector — the bot's DM history with each human counterparty becomes its own per-user subject so DM and channel signals can flow through a single sync without colliding.

| New surface | Detail |
|---|---|
| `--include-dms` flag | Pulls every DM conversation the bot user is a participant in. Combinable with `--channels` for a single mixed sync. |
| Subject routing | `dm:<other_user_id>` per DM (vs `team:<team_id>` for channels). Operators can still pass `--subject` to override. |
| New episode kinds | `slack.dm.message.posted`, `slack.dm.thread.replied` |
| New scopes | `im:read` (discover DM conversations), `im:history` (read messages) |
| Sync details | New `events_dms` and `dms_synced` counters in the per-run summary |

DMs route under per-user subjects on purpose — co-mingling a human's DMs with public channel chatter on `team:<team_id>` would surprise anyone routing on subject for retrieval. The `dm:<other_user_id>` shape mirrors how a support agent thinks about "the conversation I'm having with this person."

5 new tests in `packages/slack/tests/sync-dms.test.ts` cover: rejection when neither `--channels` nor `--include-dms` is set, accept-with-DMs-only, DM ingestion with correct subject + kind routing, mixed channels-and-DMs in a single sync, and DM thread-reply routing to `slack.dm.thread.replied`. Repo-wide tests: **181 across 10 packages**, all green.

**Bot tokens can only see DMs the bot is itself a participant in** — i.e. between a human and the bot user, not between two humans. This is a Slack platform constraint, not a connector limitation. Documented in the package README.

Out of scope for v0.3.1 (queued for later):

- DMs over the Events API webhook (currently pull-only — webhook DM dispatch lands in a follow-up)
- Multi-party DM (`mpim`) channels
- Socket Mode + channel summarization (still deferred per v0.2 plan)

## v0.3.0 — Slack reactions + pins (webhook)

`@statewavedev/connectors-slack` bumps to `0.3.0`. The webhook handler from v0.2 grows two new dispatch paths so the same `(Request) => Promise<Response>` you mount on Vercel / Cloudflare / Express also turns Slack reaction + pin events into episodes.

| New episode kind | Source |
|---|---|
| `slack.reaction.added` | Slack `reaction_added` webhook event |
| `slack.reaction.removed` | Slack `reaction_removed` webhook event |
| `slack.pin.added` | Slack `pin_added` webhook event |
| `slack.pin.removed` | Slack `pin_removed` webhook event |

Pin events inline the pinned message body (Slack carries it under `item.message`); reaction events reference the parent by `channel:ts` without re-fetching the body — re-deriving message text per reaction would multiply the per-event API budget.

Channel allowlist applies to all four kinds (filter on `event.item.channel` for reactions, `event.channel_id` for pins). Same dedup-by-`event_id` retry handling as v0.2.

13 new tests bring the slack package to **52 across 6 test files**, repo-wide to **176 across 10 packages**, all green in CI.

Slack app setup additions: subscribe to `reaction_added`, `reaction_removed`, `pin_added`, `pin_removed` (needs the `reactions:read` and `pins:read` scopes). Same signing-secret + URL-verification + retry semantics as v0.2.

Out of scope for v0.3.0 (queued for v0.3.1+):

- Direct messages (privacy + opt-in framing earns its own PR)
- Pull-mode reactions / pinned (would inflate per-channel API budget; webhook is the right place for these signals)
- Socket Mode + channel summarization (still deferred per v0.2 plan)

## v0.2.1 — Discord connector (Phase-2 complete)

`@statewavedev/connectors-discord` ships at `0.1.0` — pull-mode source connector for Discord guilds, mirroring the `@statewavedev/connectors-slack@0.1.0` shape.

| Surface | Detail |
|---|---|
| Episode kinds | `discord.message.posted`, `discord.thread.replied` |
| Auth | Bot token (`DISCORD_BOT_TOKEN`); user tokens are explicitly disallowed by Discord's TOS |
| Subject default | `community:<guild_id>` (Discord snowflake — stable across guild renames) |
| API surface | `GET /users/@me`, `GET /guilds/{id}`, `GET /guilds/{id}/channels`, `GET /channels/{id}/messages` (paginated by snowflake `before=` cursor) |
| CLI | `sync discord --guild <id> --channels <ids-or-names>` |
| Doctor | reports `DISCORD_BOT_TOKEN` |
| Test wiring | `cli test --connector discord` |

16 new unit tests (8 mapper + 8 sync) covering top-level vs thread routing, custom subject overrides, author label fallback, system-message + empty-content filtering, channel-not-found errors, and 401 handling. Repo-wide test count: **163 across 10 packages**, all green.

This closes the last Phase-2 placeholder. Realtime ingestion via Discord's Gateway WebSocket protocol (the equivalent of Slack's Socket Mode) is intentionally deferred — same daemon-shape question as Slack live-mode, will land alongside the next push-mode work.

## v0.2.0 — Slack live mode + CI hardening

`@statewavedev/connectors-slack` ships its first push-mode surface — a fetch-style Events-API webhook handler plus a CLI command (`statewave-connectors listen slack`) that wraps it in a Node http daemon for the impatient.

### What ships in `@statewavedev/connectors-slack@0.2.0`

| Surface | Detail |
|---|---|
| `createSlackWebhookHandler(config)` | Pure `(Request) => Promise<Response>`. Verifies HMAC signatures (timing-safe, with replay-window), echoes `url_verification` challenge, dedups Slack retries by `event_id`, applies the channel allowlist + the same subtype filter as the pull-mode connector, maps to the same `slack.message.posted` / `slack.thread.replied` episode shapes, and ingests via a built-in default ingest function (or a caller-supplied `StatewaveIngest`). |
| `InMemoryDedupCache` | Single-process FIFO cache, ~10k entries by default. Pluggable `SlackDedupCache` interface for Redis / Postgres / shared-memory backends. |
| `verifySlackSignature` / `computeSignature` | Helper exports for callers who want to integrate the verification step somewhere outside the bundled handler. |
| `statewave-connectors listen slack` | New CLI command. Wraps the handler in Node's `http` module (no Express dep), takes `--channels`, `--port`, `--host`, `--path`, `--signing-secret`. |
| Documentation | Package README adds deploy snippets for Vercel, Cloudflare Workers, Express, plus the daemon CLI. Cross-process dedup pattern documented. |

23 new tests (signature verification, dedup eviction, full-flow webhook scenarios). Repo-wide test count is now 147 across 9 packages.

### Out of scope for v0.2 (deferred to v0.3+)

- Socket Mode (alternative WebSocket transport for the same logical layer)
- Direct messages (opt-in per workspace)
- Reactions and pinned messages as signal episodes
- Channel summarization episodes (held until LLM-architecture call lands)

### CI hardening (no version bump)

- `@statewavedev/connectors` meta-package now has real tests asserting every Phase-1 + Phase-2 factory is re-exported (instead of an `echo` test script).
- CI smoke loop exercises every available connector via `cli test --connector {github,markdown,slack,n8n,zapier,mcp}` on every push and PR.
- Sandbox tarball install now resolves all six shipped tarballs (core, github, markdown, slack, n8n, zapier, mcp-server) into a fresh project and asserts each expected named export imports cleanly. Catches publish-time `package.json#exports` regressions that vitest can't see.

## v0.1.1 — Phase-2 connectors

Three new packages ship at `0.1.0`, all published to npm with provenance:

| Package | Shape | Episode kinds |
|---|---|---|
| `@statewavedev/connectors-slack` | Pull-mode source — channel + thread history via the Slack Web API | `slack.message.posted`, `slack.thread.replied` |
| `@statewavedev/connectors-n8n` | Pull-mode source — workflow executions via the n8n REST API | `n8n.workflow.executed`, `n8n.workflow.failed`, `n8n.node.errored` |
| `@statewavedev/connectors-zapier` | Push-mode helper — `formatZapToEpisode()` for Webhooks-by-Zapier payloads | `zapier.zap.executed`, `zapier.zap.failed` |

The Zapier package is a helper rather than a sync connector because Zapier deliberately doesn't expose a public API for enumerating other zaps' run history. The package README documents two integration paths: a no-code "POST straight to `/v1/episodes/batch`" route, and a server-side route that uses the helper to massage payloads first.

CLI updates:

- `sync slack --channels …`, `sync n8n --workflows … --instance-url …`
- `doctor` reports `SLACK_BOT_TOKEN`, `N8N_API_KEY`, `N8N_INSTANCE_URL`
- `test --connector {slack,n8n,zapier}`
- `sync` help lists Zapier under a new "helpers (no sync — push-mode integrations)" section

Slack v0.1 is intentionally pull-mode-only. Live Events-API webhook mode, Socket Mode, DMs (opt-in), reactions, pinned messages, and channel summarization are deferred — each lands in a follow-up release once the connector contract grows a long-running-daemon shape.

The Slack, n8n, and Zapier directory listings (Slack App Directory / Zapier directory) are also deferred — each requires a different SDK and review cycle and will live in separate efforts.

## v0.1.0

The first release of the Statewave Connectors monorepo.

### What ships

| Surface | Detail |
|---|---|
| Connector contract | `StatewaveConnector`, `SyncOptions`, `SyncResult` (with `summary: { total, kinds, details }` for analytics) |
| Episode shape | `StatewaveEpisode` — subject, kind, text, occurred_at, source, metadata, idempotency_key |
| Builder + helpers | `EpisodeBuilder`, `idempotencyKey`, `withRetry`, `redact`, `summarizeEpisodes`, `MemorySourceStateStore`, `FileSourceStateStore` |
| GitHub | issues, PRs, issue + PR comments (split by `html_url`), PR reviews, releases |
| Markdown | `.md`/`.mdx`, frontmatter parsing, decision/ADR/RFC detection, path + content-hash idempotency, mtime-based `--since` |
| CLI | `doctor`, `sync github\|markdown`, `replay`, `test`, `mcp start [--list-tools]`; per-command help; `--version`; ENOENT-aware error path |
| MCP server | `STATEWAVE_MCP_TOOLS`, `StatewaveClient`, `dispatchTool`, minimal stdio JSON-RPC 2.0 transport (`runStdioServer`, `startStdioServerFromEnv`), bin entry `statewave-mcp-server` with `--list-tools` / `--help` / `--version`, plus `mcp start [--list-tools]` from the connectors CLI |
| Examples | `repo-memory-quickstart` (offline-friendly, end-to-end), plus per-source READMEs |
| Docs | `connector-contract`, `episode-schema`, `subject-strategy`, `privacy-redaction`, `contribution-guide`, `roadmap` |
| CI | install → build → typecheck → test on every push and PR |

### Published packages

| Package | Notes |
|---|---|
| `@statewavedev/connectors-core` | Connector contract + utilities |
| `@statewavedev/connectors-cli` | `statewave-connectors` CLI |
| `@statewavedev/mcp-server` | MCP server (stdio transport) + `StatewaveClient` |
| `@statewavedev/connectors-github` | GitHub connector |
| `@statewavedev/connectors-markdown` | Markdown / docs connector |
| `@statewavedev/connectors` | Convenience meta-package |

All published with npm provenance attestations.

The Discord, Notion, Zendesk, Intercom, Freshdesk, and Gmail connector packages remain `private:true` placeholders until each one ships a real implementation. They are not on npm. (Slack, n8n, and Zapier shipped in v0.1.1 — see above.)

### Intentionally not in v0.1.0

- **HTTP MCP transport.** The bundled stdio JSON-RPC 2.0 transport is enough for any MCP-compatible client. An HTTP transport ships in a follow-up release.
- **Phase 2+ connectors** (Discord, Zendesk, Intercom, Freshdesk, Notion, Gmail). Slack, n8n, and Zapier landed in v0.1.1.

### Known limitations

- The `replay` command is a thin wrapper over `sync --dry-run`; it does not yet persist or compare cursors.
- The MCP `StatewaveClient` targets the Statewave v1 paths (`/v1/episodes`, `/v1/memories/search`, `/v1/context`, `/v1/timeline`, `/v1/memories/compile`). If your Statewave instance exposes different paths, wrap the client.
- Best-effort secret redaction covers common token shapes (GitHub PATs, OpenAI/Anthropic keys, AWS access keys, Slack tokens, JWTs, PEM blocks) but is **not** a substitute for proper data handling. Always review dry-run output before ingesting.
- Tests run fully offline by stubbing `fetch`; CI is not gated on real GitHub or Statewave connectivity.

### Contributing

See [docs/contribution-guide.md](docs/contribution-guide.md). New connectors must:

- depend only on `@statewavedev/connectors-core`
- implement the `StatewaveConnector` contract
- ship deterministic mapper tests
- include a dry-run example
- never require credentials for any other connector
