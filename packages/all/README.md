# @statewavedev/connectors

> Convenience meta-package — re-exports the official Phase-1 Statewave connectors.

**This package is optional.** Normal usage is to install only the connector packages you need:

```bash
npm install @statewavedev/connectors-github
npm install @statewavedev/connectors-markdown
npm install @statewavedev/mcp-server
```

If you'd rather pull all of Phase 1 with one install, you can use this:

```bash
npm install @statewavedev/connectors
```

It re-exports:

- everything from `@statewavedev/connectors-core` (`StatewaveEpisode`, `EpisodeBuilder`, …)
- `createGithubConnector` from `@statewavedev/connectors-github`
- `createMarkdownConnector` from `@statewavedev/connectors-markdown`
- `createSlackConnector` from `@statewavedev/connectors-slack`
- `createN8nConnector` from `@statewavedev/connectors-n8n`
- `formatZapToEpisode` from `@statewavedev/connectors-zapier`
- `createDiscordConnector` from `@statewavedev/connectors-discord`
- `createZendeskConnector` from `@statewavedev/connectors-zendesk`
- `createIntercomConnector` from `@statewavedev/connectors-intercom`
- `createFreshdeskConnector` from `@statewavedev/connectors-freshdesk`
- `createNotionConnector` from `@statewavedev/connectors-notion`
- `createGmailConnector` from `@statewavedev/connectors-gmail`

All Phase-1 connector packages have shipped. The meta-package re-exports every one of them.

## Status

`v0.1.0` preview. See [RELEASE_NOTES.md](https://github.com/smaramwbc/statewave-connectors/blob/main/RELEASE_NOTES.md).
