# @statewavedev/connectors-gitea

Gitea / Forgejo connector for Statewave — turns repository activity into normalized episodes under `repo:<owner>/<repo>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Issue opened | `gitea.issue.opened` |
| Issue closed | `gitea.issue.closed` |
| Issue comment | `gitea.issue.comment` |
| Pull request opened | `gitea.pr.opened` |
| Pull request closed (not merged) | `gitea.pr.closed` |
| Pull request merged | `gitea.pr.merged` |
| PR comment | `gitea.pr.comment` |
| PR review | `gitea.pr.review` |
| Release published | `gitea.release.published` |

## Example episode

```json
{
  "subject": "repo:acme/widgets",
  "kind": "gitea.issue.opened",
  "text": "ada opened issue #42: CI is flaky\n\nhappens on macos runners",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "gitea.issue", "id": "acme/widgets#42", "url": "https://gitea.example.com/acme/widgets/issues/42" },
  "metadata": { "issue_number": 42, "author": "ada", "labels": ["bug", "ci"], "state": "open" }
}
```

Run `statewave-connectors sync gitea --host https://gitea.example.com --repo acme/widgets --dry-run --json` to see this exact shape.

## Quickstart

```bash
statewave-connectors sync gitea \
  --host https://gitea.example.com \
  --repo owner/repo \
  --dry-run
```

Gitea is self-hosted, so the instance URL is **required**: pass `--host https://gitea.example.com` or set `GITEA_URL`. `GITEA_TOKEN` is optional for public repositories but strongly recommended (unauthenticated reads hit lower rate limits). Both are only read by this connector.

### Forgejo

[Forgejo](https://forgejo.org) is a community fork of Gitea and exposes the same REST API (`/api/v1`). Point `--host` at your Forgejo instance and this connector works unchanged.

See the connector docs for detail: <https://github.com/smaramwbc/statewave-docs/blob/main/connectors/gitea.md>.

## Status

`v0.1.0` preview. Mapping unit-tested **and smoke-validated live against Codeberg (Forgejo 15.0.0 / gitea-1.22.0)** — issues, PRs, comments, reviews, releases — on 2026-05-30. Two live findings were fixed (PR-comment parent number from `pull_request_url`; skip `REQUEST_REVIEW`). See [docs/forge-connectors-smoke-report.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/forge-connectors-smoke-report.md).
