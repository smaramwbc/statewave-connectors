# @statewave/connectors-n8n

> Status: **Placeholder** — planned for Phase 5 of the connector roadmap. No implementation yet.

The n8n connector will turn workflow runs into Statewave episodes so agents have **workflow memory** — what ran, what failed, what changed in the data, what got escalated.

## Planned scope

- Workflow executions (success and failure)
- Per-node errors as separate episodes
- Captured input/output snippets, redacted by default

## Planned subject strategy

- `workflow:<n8n-workflow-id>`
- Related subjects: `customer:<account>` when the workflow operates on a specific account

## Planned event kinds

- `n8n.workflow.executed`
- `n8n.workflow.failed`
- `n8n.node.errored`

## Planned auth

- n8n API key per instance
- Read-only by default
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
