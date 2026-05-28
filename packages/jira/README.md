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
- **Pull mode only** — no webhook receiver.
- **Read-only** — issues and, opt-in, comments. Never writes to Jira.
- Project **allowlist required** — a connector instance pulls only the projects you name.
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

`v0.1.0` **preview**. Pull-mode, Jira Cloud only. Webhook receiver and Jira
Data Center support are not included.
