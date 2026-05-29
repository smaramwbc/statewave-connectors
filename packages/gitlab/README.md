# @statewavedev/connectors-gitlab

GitLab connector for Statewave — turns project activity into normalized episodes under `repo:<group>/<project>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Issue opened | `gitlab.issue.opened` |
| Issue closed | `gitlab.issue.closed` |
| Issue comment (note) | `gitlab.issue.comment` |
| Merge request opened | `gitlab.mr.opened` |
| Merge request closed (not merged) | `gitlab.mr.closed` |
| Merge request merged | `gitlab.mr.merged` |
| Merge request comment (note) | `gitlab.mr.comment` |
| Merge request approval | `gitlab.mr.approval` |
| Release published | `gitlab.release.published` |

System notes (state changes, label edits, etc.) are skipped — only human comments become episodes.

## Example episode

```json
{
  "subject": "repo:acme/widgets",
  "kind": "gitlab.mr.merged",
  "text": "linus merged merge request !100: Add MCP server\n\nimplements the skeleton",
  "occurred_at": "2026-05-20T09:12:00.000Z",
  "source": { "type": "gitlab.merge_request", "id": "acme/widgets!100", "url": "https://gitlab.com/acme/widgets/-/merge_requests/100" },
  "metadata": { "mr_iid": 100, "author": "linus", "labels": [], "state": "merged", "merged": true, "target_branch": "main" }
}
```

Run `statewave-connectors sync gitlab --repo acme/widgets --dry-run --json` to see this exact shape.

## Quickstart

```bash
statewave-connectors sync gitlab \
  --repo group/project \
  --host https://gitlab.com \
  --dry-run
```

Nested groups work too — pass the full path (`--repo group/sub/project`); the last segment is the project, the rest is the namespace.

`GITLAB_TOKEN` is optional for public projects but recommended (the unauthenticated rate limit is small). When set, it is sent as the `PRIVATE-TOKEN` header. It is only read by this connector.

> Approvals carry no per-approval timestamp on the GitLab API, so approval episodes use the merge request's `updated_at` as their `occurred_at`.

See the connector docs for detail: <https://github.com/smaramwbc/statewave-docs/blob/main/connectors/gitlab.md>.

## Status

`v0.1.0` preview. The mapping + pagination are unit-tested; live GitLab API validation is pending (live-unverified).
