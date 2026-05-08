# @statewave/connectors

> Convenience meta-package — re-exports the official Phase-1 Statewave connectors.

**This package is optional.** Normal usage is to install only the connector packages you need:

```bash
npm install @statewave/connectors-github
npm install @statewave/connectors-markdown
npm install @statewave/mcp-server
```

If you'd rather pull all of Phase 1 with one install, you can use this:

```bash
npm install @statewave/connectors
```

It re-exports:

- everything from `@statewave/connectors-core` (`StatewaveEpisode`, `EpisodeBuilder`, …)
- `createGithubConnector` from `@statewave/connectors-github`
- `createMarkdownConnector` from `@statewave/connectors-markdown`

It does **not** re-export the placeholder packages (Slack, Discord, Notion, Zendesk, Intercom, Freshdesk, Gmail, n8n, Zapier) — those have not shipped yet.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
