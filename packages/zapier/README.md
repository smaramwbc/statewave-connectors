# @statewave/connectors-zapier

> Status: **Placeholder** — planned for Phase 5 of the connector roadmap. No implementation yet.

The Zapier connector will turn zap runs into Statewave episodes so agents have workflow memory across the long tail of SaaS-to-SaaS automations Zapier already powers.

## Planned scope

- Zap runs (success, failure)
- Step-level errors as separate episodes
- Input/output snapshots, redacted by default

## Planned subject strategy

- `workflow:<zap-id>`
- Related subjects: `customer:<account>` when applicable

## Planned event kinds

- `zapier.zap.run`
- `zapier.zap.failed`

## Planned auth

- Zapier developer credentials / NLA token, scoped per workspace
- Credentials are local to this connector

## Track progress

See [docs/roadmap.md](../../docs/roadmap.md).
