# @statewavedev/connectors-github

GitHub connector for Statewave — turns repository activity into normalized episodes under `repo:<owner>/<repo>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Issue opened | `github.issue.opened` |
| Issue closed | `github.issue.closed` |
| Issue comment | `github.issue.comment` |
| Pull request opened | `github.pr.opened` |
| Pull request closed (not merged) | `github.pr.closed` |
| Pull request merged | `github.pr.merged` |
| PR comment | `github.pr.comment` |
| PR review | `github.pr.review` |
| Release published | `github.release.published` |

## Quickstart

```bash
statewave-connectors sync github \
  --repo smaramwbc/statewave \
  --subject repo:smaramwbc/statewave \
  --dry-run
```

`GITHUB_TOKEN` is optional for public repos but strongly recommended (the unauthenticated rate limit is small). It is only read by this connector.

See the connector docs for detail: <https://github.com/smaramwbc/statewave-docs/blob/main/connectors/github.md>.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
