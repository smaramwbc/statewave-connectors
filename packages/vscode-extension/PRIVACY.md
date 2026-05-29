# Privacy statement — Statewave IDE Companion

**Plain version: the extension never reads your assistant chat, never sends
telemetry, and only talks to the Statewave server you configure.**

## What it observes
The workspace file tree (classified, ignore-filtered), README/docs/ADR/RFC
content, git branch/remote/recent history, lightweight code structure
(symbol names/kinds only — never source bodies), editor diagnostics
(messages/locations only), and files you save (only if you enable
`statewave.autoIndex`).

## What it never does
- **Never reads Copilot/Cursor/Claude/etc. chat.** No interception, no
  transcript access. Conversational facts enter memory only because the
  *assistant itself* calls the public `statewave_ingest_episode` MCP tool,
  driven by an opt-out instruction — a visible, approvable model action.
- **Never sends telemetry or phones home.** The only network destination is
  your configured `statewave.url`.
- **Never ingests secrets.** `.env*`, `*.pem`, `*.key`, `id_rsa`,
  `credentials`, keystores, etc. are a hard skip and cannot be opted in via
  `includeGlobs`. `node_modules`, build output, lockfiles are excluded.
- **Never ingests on install/activation.** Preview-first; you press Ingest.
- **No side effects in untrusted workspaces.**

## Where data goes
Episodes are sent only to your `statewave.url`. The API key lives in your
local VS Code settings and, for file-based MCP clients, only in home-dir /
editor-storage config (never the repository). Agent-instruction files
contain no secrets and are meant to be committed.

## Optional GitHub history connector

`statewave.github.enabled` is **off by default**. When you turn it on, the
manual `Statewave: Sync GitHub Project History` command pulls issues / PRs /
comments / reviews / releases from `api.github.com` for the configured
repo and ingests them under the same workspace subject. It is manual only —
never runs on activation or in the watcher loop.

- **Auth:** the default path is VS Code's built-in `github` authentication
  session (`vscode.authentication.getSession('github', ['repo'])`). The
  token lives in your OS keychain — never typed into settings, never in
  the repo, never logged.
- **Fallback:** `statewave.github.token` exists only for editors without the
  built-in provider (some forks, headless). Prefer **User/Machine** settings,
  never committed workspace settings. Public repos work with no token.
- **Scope:** the only network destinations are `api.github.com` (read) and
  your configured `statewave.url` (ingest). No telemetry. Same redaction
  rules apply.

## Optional history connector for other forges

`statewave.forge.enabled` is **off by default**. When you turn it on, the
manual `Statewave: Sync Project History` command does the same thing for
**GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps and GitHub Enterprise
Server** — auto-detecting the forge from the workspace git remote (or
`statewave.forge.kind`). Same hard rules: manual only, preview-first, never on
activation or in the watcher loop.

- **Auth:** GitHub/GHES use the built-in `github` session; Azure DevOps tries
  the built-in `microsoft` session. GitLab/Bitbucket/Gitea have no built-in
  editor provider, so they use `statewave.forge.token` — a personal/project
  access token. Prefer **User/Machine** settings, never committed workspace
  settings. The token is never logged and never written to the repo.
- **Scope:** the only network destinations are the forge's API host (read —
  `gitlab.com`/`bitbucket.org`/`dev.azure.com`, or your self-managed
  `statewave.forge.host`) and your configured `statewave.url` (ingest). No
  telemetry. The same email/phone/secret redaction applies before anything
  leaves the editor.

## Your controls
`statewave.redaction.enabled` (on by default), `statewave.assistantInstructions`
(`read-write`/`read-only`/`off`), `statewave.autoIndex` (off by default),
`statewave.mcp.autoWire` + `statewave.mcp.clients`, `Statewave: Show Indexed
Files`, and `Statewave: Reset Local Integration` to undo everything.
