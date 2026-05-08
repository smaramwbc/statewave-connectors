# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets) — the tool the repo uses to track version bumps and publish releases.

## Adding a changeset

When you make a change that should ship in a release:

```sh
pnpm changeset
```

The CLI will ask which packages changed, what kind of bump each needs (patch / minor / major), and a short summary. It writes a `*.md` file here that gets consumed at release time.

## What happens at release

The `Release` GitHub Actions workflow runs `pnpm version` (which is `changeset version`) when changesets exist. That command:

- bumps versions in each `packages/*/package.json`
- updates `workspace:^` internal dep ranges to the new versions
- writes `CHANGELOG.md` per package

A maintainer merges the resulting "release" PR. The next workflow run runs `pnpm release` (which is `changeset publish`), which `npm publish`es each package with `--provenance`.

## Why no initial changeset for v0.1.0

The first public preview lives in `package.json` as `0.1.0` directly — there's nothing to bump *from*. Future versions go through the changeset flow above.

## Linked packages

The Phase-1 packages (core, cli, mcp-server, github, markdown, plus the `@statewave/connectors` meta) are **linked** in `config.json`: they always share a version. That keeps the install matrix simple while the surface is small. We can split them later if any package needs to evolve independently.
