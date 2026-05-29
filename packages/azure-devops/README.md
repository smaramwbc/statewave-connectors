# @statewavedev/connectors-azure-devops

Azure DevOps connector for Statewave — turns pull requests, comments, reviews, and work items into normalized episodes under `repo:<organization>/<project>/<repository>`.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem.

## What it ingests

| Source event | Episode `kind` |
|---|---|
| Pull request opened (active) | `azure.pr.opened` |
| Pull request abandoned | `azure.pr.closed` |
| Pull request completed (merged) | `azure.pr.merged` |
| PR thread comment | `azure.pr.comment` |
| PR reviewer vote | `azure.pr.review` |
| Work item created | `azure.workitem.created` |
| Work item closed | `azure.workitem.closed` |

## Example episode

```json
{
  "subject": "repo:acme/platform/widgets",
  "kind": "azure.pr.merged",
  "text": "Linus T merged PR !100: Add MCP server\n\nimplements the skeleton",
  "occurred_at": "2026-01-03T00:00:00.000Z",
  "source": { "type": "azure.pull_request", "id": "acme/platform/widgets#100", "url": "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/100" },
  "metadata": { "pr_id": 100, "author": "Linus T", "status": "completed", "merged": true }
}
```

Run `statewave-connectors sync azure-devops --repo acme/platform/widgets --dry-run --json` to see this exact shape.

## Quickstart

```bash
statewave-connectors sync azure-devops \
  --repo myorg/myproject/myrepo \
  --dry-run
```

The repo argument is a three-part `organization/project/repository` spec (a two-part spec is rejected).

`AZURE_DEVOPS_PAT` carries a [Personal Access Token](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate). It is sent via HTTP Basic auth (empty username, PAT as password) and is only read by this connector. For on-prem Azure DevOps Server, pass `--base-url https://your-host/tfs` (defaults to `https://dev.azure.com`).

### Required PAT scopes

| Data | Scope |
|---|---|
| Pull requests, comments, reviews | **Code (Read)** |
| Work items | **Work Items (Read)** |

## Caveats

- **No per-vote review timestamp.** Azure DevOps does not expose a timestamp for an individual reviewer vote, so `azure.pr.review` episodes use the PR's `closedDate` (falling back to `creationDate`) as `occurred_at`.
- Reviewer votes map as: `10` → approved, `5` → approved with suggestions, `-5` → waiting for author, `-10` → rejected. A vote of `0` (no response) produces no review episode.
- System-generated PR thread comments (`commentType: "system"`) are skipped.

See the connector docs for detail: <https://github.com/smaramwbc/statewave-docs/blob/main/connectors/azure-devops.md>.

## Status

`v0.1.0` preview. Mapping + WIQL flow unit-tested. The **bad-auth path is live-confirmed** (anonymous requests get an HTML sign-in redirect → `auth_failed`), but the PR / comment / reviewer-vote / work-item **shapes are not yet live-verified** — they need a real Azure DevOps organization + PAT (scopes Code:Read, Work Items:Read) before this leaves preview. See [docs/forge-connectors-smoke-report.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/forge-connectors-smoke-report.md) and [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
