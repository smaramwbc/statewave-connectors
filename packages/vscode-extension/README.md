# Statewave IDE Companion (VS Code / Cursor)

Makes Statewave aware of your **workspace, project structure, docs, run-commands, git state, and diagnostics**, then lets Copilot / Cursor read that memory back through the existing Statewave MCP server.

> Part of the [Statewave Connectors](https://github.com/smaramwbc/statewave-connectors) ecosystem. Editor-independent logic lives in [`@statewavedev/ide-core`](../ide-core).

## Install

<a href="https://marketplace.visualstudio.com/items?itemName=statewavedev.statewave-ide-companion"><img src="media/icon.png" alt="Statewave IDE Companion" width="72" align="right"></a>

Published for VS Code, Cursor, and other VS Code–based editors — the extension registers the MCP server for you, so there's no `mcp.json` to hand-edit.

- **VS Code** — [Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=statewavedev.statewave-ide-companion)
- **Cursor · Windsurf · VSCodium** — [Install from Open VSX](https://open-vsx.org/extension/statewavedev/statewave-ide-companion)
- **Any editor** — open the **Extensions** panel and search **"Statewave IDE Companion"** (publisher `statewavedev`).

You'll still need a Statewave server for the extension to talk to — see below.

## Connect your Statewave server

**One command** — spin up the server + admin + DB (Docker required), zero config files to write:

```sh
npx @statewavedev/connectors-cli quickstart
```

That starts the stack on the defaults the plugin already expects (`http://localhost:8100`), so the moment it's up the extension is connected — nothing else to set. Stop it later with the same command plus `--down`.

`statewave.apiKey` can stay empty for local dev. The plugin handles MCP wiring itself, so you don't need any of the CLI's other commands.

<details>
<summary><strong>Advanced — hand-rolled Docker Compose</strong> (production, custom ports, pinned versions, secrets)</summary>

If you want to manage the stack yourself, save this as `statewave.docker-compose.yml`:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: statewave
      POSTGRES_PASSWORD: statewave
      POSTGRES_DB: statewave
    volumes:
      - statewave-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U statewave"]
      interval: 2s
      timeout: 5s
      retries: 10

  api:                                       # the Statewave server
    image: statewavedev/statewave:${STATEWAVE_VERSION:-latest}
    ports:
      - "${STATEWAVE_API_HOST_PORT:-8100}:8100"   # matches statewave.url default
    environment:
      STATEWAVE_DATABASE_URL: postgresql+asyncpg://statewave:statewave@db:5432/statewave
      STATEWAVE_DEBUG: "true"                # local dev: accepts any X-API-Key
    depends_on:
      db:
        condition: service_healthy

  admin:                                     # operator console (browse subjects/episodes/memories)
    image: statewavedev/statewave-admin:${STATEWAVE_ADMIN_VERSION:-latest}
    ports:
      - "${STATEWAVE_ADMIN_HOST_PORT:-8080}:8080"
    environment:
      STATEWAVE_API_URL: http://api:8100
      STATEWAVE_API_KEY: ${STATEWAVE_API_KEY:-dev-local-placeholder}
      ADMIN_AUTH_DISABLED: "true"            # local dev only
      NODE_ENV: production
    depends_on:
      api:
        condition: service_started

volumes:
  statewave-pgdata:
```

```sh
docker compose -f statewave.docker-compose.yml up -d
curl http://localhost:8100/healthz     # server health
open  http://localhost:8080            # admin console
```

**Production — do not ship the dev defaults:** drop `STATEWAVE_DEBUG`, set a real `STATEWAVE_API_KEY` (and use it as the plugin's `statewave.apiKey` in **User** settings); drop `ADMIN_AUTH_DISABLED` and set `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET`; pin image versions via `STATEWAVE_VERSION` / `STATEWAVE_ADMIN_VERSION`. Port clash? override `STATEWAVE_API_HOST_PORT` / `STATEWAVE_ADMIN_HOST_PORT` / `STATEWAVE_DB_HOST_PORT` (and point `statewave.url` at the new API port). Full server docs: [statewave/DOCKER.md](https://github.com/smaramwbc/statewave/blob/main/DOCKER.md).

> Just the core, no admin? `docker compose -f statewave.docker-compose.yml up -d api db`.

</details>

## The plugin never reads your Copilot/Cursor/Claude chat

There is no transcript access and no interception. On its own the extension observes only:

- the workspace file tree (classified, ignore-filtered)
- README / docs / ADR / RFC / decision documents (+ git history, code structure)
- declared run-commands — `package.json` `scripts`, `Makefile` targets, `pyproject.toml` script tables (the command **names + lines** only — **never source bodies, lockfiles, or env files**)
- git branch + remote (parsed from `.git/`, no `git` spawned)
- editor diagnostics (messages + locations only — **never source code**)
- files you save (only when you turn on `statewave.autoIndex`)

**Conversational facts** ("my favorite color is red") enter memory only because, with
`statewave.assistantInstructions: read-write` (default), we write a no-secret rules
file telling the **assistant** to call the public `statewave_ingest_episode` MCP tool
when *you* state a durable fact. That is the model taking a visible, approvable
action — not the plugin scraping chat. Set `read-only` (consult only) or `off`.

## Safety model

- **No ingestion on install or activation.** Activation registers commands and nothing else.
- **Preview-first.** Every command previews episodes in the *Statewave IDE Companion* output channel; sending is a separate, explicit button press.
- **`statewave.autoIndex` is off by default.** It is the only switch that lets the file watcher send anything without a button press, and you turn it on yourself.
- **Redaction on by default** (`statewave.redaction.enabled`) — email / phone / API-key shapes are scrubbed before anything leaves the editor.
- **Auto-wiring keeps secrets out of the repo.** MCP config is written only to home-dir / editor-storage files (or in-memory for Copilot); the API key never lands in version control. Agent-instruction files carry no secrets and are meant to be committed.
- **No telemetry. No phone-home.** The only network call is to your configured `statewave.url`.

## Commands

| Command | What it does |
|---|---|
| `Statewave: Build Project Memory` | Scan + classify the workspace, build the project summary, detect docs/architecture, collect diagnostics → preview, then optional ingest |
| `Statewave: Sync Changed Files` | Map debounced saved/created/deleted files → preview, then optional ingest |
| `Statewave: Show Project Memory Summary` | Open the rendered project summary (no network) |
| `Statewave: Compile Project Memory` | Compile the subject now → raw episodes (incl. assistant-captured facts) become retrievable memory |
| `Statewave: Open Project Understanding` | Provenance-backed live summary of the repo (webview, no AI generation) |
| `Statewave: Show Indexed Files` | Exactly what is indexed / skipped and **why** (secrets are a hard skip) |
| `Statewave: Diagnose` | Health report — server, auth, subject, MCP, clients, compile — with fixes |
| `Statewave: Status & Actions` | The status-bar menu (also shows live state) |
| `Statewave: Reset Local Integration` | Remove every MCP entry / instruction file / cache this extension wrote |
| `Statewave: Sync GitHub Project History` | **Opt-in** — pulls issues/PRs/comments/reviews/releases via `@statewavedev/connectors-github` for the long-term "why". Manual; preview-first; default auth via VS Code's `github` session (no token in settings). |
| `Statewave: Sync Project History` | **Opt-in** — the same thing for **GitLab, Bitbucket, Gitea/Forgejo, Azure DevOps and GitHub Enterprise Server**. Auto-detects the forge from the workspace git remote (`statewave.forge.kind` to force one). Manual; preview-first; token never in the repo. |
| `Statewave: Configure Statewave` | Jump to the `statewave.*` settings |

## Settings

`statewave.url`, `statewave.apiKey`, `statewave.subjectStrategy`, `statewave.subject` (override), `statewave.autoIndex`, `statewave.includeGlobs`, `statewave.excludeGlobs`, `statewave.redaction.enabled`, `statewave.compileAfterIngest`, `statewave.mcp.autoWire`, `statewave.mcp.clients`, `statewave.assistantInstructions`, `statewave.github.*` (opt-in GitHub history connector), `statewave.forge.*` (opt-in GitLab / Bitbucket / Gitea / Azure DevOps / GitHub Enterprise history connector). See [docs/vscode-extension.md](https://github.com/smaramwbc/statewave-connectors/blob/main/docs/vscode-extension.md).

## Develop / package

```sh
pnpm install
pnpm --filter @statewavedev/ide-core build
pnpm --filter statewave-ide-companion build      # esbuild → dist/extension.cjs
# F5 in VS Code (Run Extension) loads it in an Extension Development Host.
# Or build a VSIX:
pnpm --filter statewave-ide-companion package
# Full release gate (build+lint+typecheck+test+package+leak-scan):
pnpm --filter statewave-ide-companion preview-release
```

> The package is named `statewave-ide-companion` (a marketplace-valid id `statewavedev.statewave-ide-companion`) rather than a scoped npm name, because the VS Code extension manifest *is* its `package.json` and the marketplace rejects `/` in `name`. It is `private` and never published to npm; changesets ignore it automatically.

## More

- [CHANGELOG.md](CHANGELOG.md) · [PRIVACY.md](PRIVACY.md) · [SECURITY.md](SECURITY.md) · [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- Run **Statewave: Diagnose** for an actionable health report; **Statewave: Open Project Understanding** for a provenance-backed live summary.

## Status

Available as a preview. See [CHANGELOG.md](CHANGELOG.md) for the per-release history.

## License

Apache-2.0.
