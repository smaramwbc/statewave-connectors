# @statewavedev/connectors-bitbucket

Bitbucket Cloud connector for Statewave — turns repository activity into normalized episodes under `repo:<workspace>/<repo>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Issue opened | `bitbucket.issue.opened` |
| Issue closed (resolved / closed / invalid / duplicate / wontfix) | `bitbucket.issue.closed` |
| Issue comment | `bitbucket.issue.comment` |
| Pull request opened | `bitbucket.pr.opened` |
| Pull request closed (DECLINED / SUPERSEDED) | `bitbucket.pr.closed` |
| Pull request merged | `bitbucket.pr.merged` |
| PR comment | `bitbucket.pr.comment` |

## Example episode

```json
{
  "subject": "repo:myworkspace/myrepo",
  "kind": "bitbucket.pr.merged",
  "text": "linus merged PR #7: feat: thing\n\ndo stuff",
  "occurred_at": "2026-02-03T00:00:00.000Z",
  "source": { "type": "bitbucket.pull_request", "id": "myworkspace/myrepo#7", "url": "https://bitbucket.org/myworkspace/myrepo/pull-requests/7" },
  "metadata": { "pr_id": 7, "author": "linus", "state": "closed", "merged": true, "source_branch": "feat/thing", "destination_branch": "main" }
}
```

Run `statewave-connectors sync bitbucket --repo myworkspace/myrepo --dry-run --json` to see this exact shape.

## Quickstart

```bash
statewave-connectors sync bitbucket \
  --repo myworkspace/myrepo \
  --subject repo:myworkspace/myrepo \
  --dry-run
```

`BITBUCKET_TOKEN` is optional for public repos but recommended (the unauthenticated rate limit is small). It is only read by this connector and sent as a `Bearer` token.

> App-password caveat: this connector authenticates with a `Bearer` token (an
> access token / OAuth token). Bitbucket app passwords use HTTP Basic auth and
> are not supported yet — use an access token instead.

See the connector docs for detail: <https://github.com/smaramwbc/statewave-docs/blob/main/connectors/bitbucket.md>.

## Status

`v0.1.0` preview. Mapping + pagination unit-tested; PR/comment shapes, `next` pagination and the BBQL `since` query **smoke-validated live against bitbucket.org** on 2026-05-30 (the full end-to-end run was capped by Bitbucket's unauthenticated per-IP rate limit) — see [docs/forge-connectors-smoke-report.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/forge-connectors-smoke-report.md). See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
