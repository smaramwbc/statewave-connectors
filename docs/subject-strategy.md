# Subject strategy

The single most important decision when adding a connector is **what subject(s) does this source's data belong to?**. Subject choice determines what memories get compiled together and what an agent can recall in one query.

A few principles:

- **Subjects are stable, low-cardinality identifiers.** Not free text, not per-event ids.
- **One episode has one primary subject.** Use `metadata.related_subjects` to cross-link.
- **Pick the subject your agent will *ask about*.** "What's going on with Acme?" → `customer:acme`. "What was decided about licensing?" → `repo:smaramwbc/statewave` with `decision:licensing` as a related subject.
- **When in doubt, pick the more general subject and refine via related subjects.** It's easier to broaden retrieval than to merge stale subjects later.

## Common patterns

### Repo memory

```
subject = repo:<owner>/<repo>
```

Use for: GitHub issues, PRs, comments, releases, ADRs, architecture docs that govern the repo, internal Notion decision pages tied to the repo.

```
# GitHub PR
subject = repo:smaramwbc/statewave
metadata.related_subjects = ["pr:35", "author:smaram"]
```

### Customer memory

```
subject = customer:<account-slug>
```

Use for: Zendesk tickets, Intercom conversations, Freshdesk replies, support-channel Slack threads.

```
# Zendesk ticket
subject = customer:acme
metadata.related_subjects = ["ticket:12345", "product:admin"]
```

### Community memory

```
subject = community:<server>
```

Use for: Discord channels and forums, public Slack communities, public GitHub discussions.

```
# Discord question
subject = community:statewave
metadata.related_subjects = ["user:discord-id", "topic:mcp"]
```

### Contact / relationship memory

```
subject = contact:<email>
```

Use for: Gmail threads, calendar invites, CRM-like signal.

```
# Gmail thread
subject = contact:person@example.com
metadata.related_subjects = ["company:acme"]
```

### Decision memory

```
subject = repo:<owner>/<repo>           # if the decision governs a repo
subject = workspace:<notion-workspace>  # if the decision is org-wide
metadata.related_subjects = ["decision:<topic>"]
```

Use for: ADRs, RFCs, architecture notes, Notion decision docs.

```
# Notion decision doc
subject = repo:smaramwbc/statewave
metadata.related_subjects = ["decision:licensing"]
```

### Workflow memory

```
subject = workflow:<workflow-id>
```

Use for: n8n executions, Zapier zap runs, internal job queues.

```
# n8n execution
subject = workflow:n8n-onboarding-1
metadata.related_subjects = ["customer:acme"]
```

## Choosing per-connector

Connectors expose a sensible default subject (e.g. GitHub defaults to `repo:owner/name`), and accept `--subject` to override. When in doubt, prefer a subject your *agents* will use unprompted; an agent asking "what's the deal with Acme?" will not naturally search `ticket:12345`.

## Anti-patterns

- **Per-message subjects.** `subject = message:abc123` defeats memory compilation; you'll get one memory per message and no recall by topic.
- **Time-based subjects.** `subject = 2026-Q1` makes recall painful and undermines drift-resistance.
- **Mixing cardinality.** Don't mix `customer:acme` and `customer:acme/north-america/team-7` for the same agent — pick one granularity.
