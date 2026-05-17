# IDE memory — how Copilot / Cursor read the workspace back

The IDE Companion writes workspace memory **in**. This document is the **out** side: how an MCP-compatible assistant (GitHub Copilot, Cursor, or your own agent) retrieves it.

The retrieval side adds **no new MCP tools**. The companion was designed so the existing canonical Statewave MCP surface is sufficient:

```
statewave_get_context      statewave_get_timeline
statewave_search_memories  statewave_compile_subject   statewave_ingest_episode
```

If you can already call those (see [examples/copilot-mcp-memory](../examples/copilot-mcp-memory)), you can already consume IDE memory. Nothing to add or upgrade on the MCP server.

## The subject is the contract

Everything the companion ingests is scoped to one **subject**:

- `repo:<owner>.<repo>` when the workspace has a git remote, else
- `workspace:<folder-slug>`, or
- whatever `statewave.subject` overrides it to.

> The Statewave server validates `subject_id` against `^[A-Za-z0-9_.\-:]+$`, which excludes `/`. The companion therefore sanitizes the subject — `/` becomes `.`, so the documented `repo:<owner>/<repo>` is emitted as `repo:<owner>.<repo>`. It's still stable and readable; it's just the form the server accepts. Any other out-of-set character collapses to `-`.

That subject is the single key an assistant queries. Pick it once; it stays stable. See [subject-strategy.md](./subject-strategy.md).

## Episode kinds the companion produces

| Kind | Meaning | Idempotency |
|---|---|---|
| `ide.workspace.indexed` | A full classified scan happened | content hash of the file set |
| `ide.project.summary` | Durable project model (languages, toolchain, layout, conventions) | content hash of the rendered summary |
| `ide.git.context` | Current branch + remote | branch + remote |
| `ide.docs.detected` | Digest of every documentation surface | content hash of the doc set |
| `ide.architecture.detected` | One per ADR / RFC / decision doc | path + content hash |
| `ide.file.changed` | One debounced save / create / delete | path + content hash (saves) |
| `ide.diagnostics.reported` | Digest of recurring errors/warnings (no source) | hash of the grouped signatures |

Idempotency is **content-addressable**: re-running an unchanged scan re-maps to the same `idempotency_key`, so Statewave dedupes; a changed workspace yields a new memory. These kinds are descriptive — Statewave does not require any specific value (see [episode-schema.md](./episode-schema.md)).

## Retrieval mapping (use the canonical tools)

| The assistant wants… | Call | Arguments |
|---|---|---|
| Project summary, conventions, relevant docs | `statewave_get_context` | `subject` = the workspace subject, `query` = the task at hand |
| Repo conventions specifically | `statewave_get_context` / `statewave_search_memories` | `subject`, `query: "repo conventions"` |
| Recent changed files | `statewave_get_timeline` | `subject`, `kinds: ["ide.file.changed"]` |
| Architecture / decision history | `statewave_get_timeline` | `subject`, `kinds: ["ide.architecture.detected"]` |
| Diagnostics summary | `statewave_get_timeline` | `subject`, `kinds: ["ide.diagnostics.reported"]` |
| "What is this project?" one-shot | `statewave_get_context` | `subject`, `query: "project overview"` |

`statewave_get_context` already returns compact, ranked context assembled from the compiled memories — the assistant should prefer it over stuffing raw history. `statewave_get_timeline` with a `kinds` filter is the precise path for "what changed / what was decided / what's broken" because the companion tags every episode with a stable `ide.*` kind.

### Example agent prompt flow

> User: "Get me up to speed on this repo before we touch the auth code."

1. Assistant calls `statewave_get_context` with `subject=repo:acme.widgets`, `query="auth code conventions and recent changes"`.
2. Statewave returns the compiled project summary + conventions + the most relevant ADRs/docs, already token-bounded.
3. (Optional) Assistant calls `statewave_get_timeline` with `kinds:["ide.architecture.detected"]` to cite the specific decision docs.

No raw chat scraping, no bespoke RAG index — the workspace memory was put there explicitly by the developer via the companion, and read back through the same MCP contract every other connector uses.

## Why no IDE-specific MCP tools

Goal: "use existing canonical MCP tools where possible; only add new tools if necessary." Retrieval needs are *subject-scoped context* and *kind-filtered timelines* — both already first-class on the server. Adding `ide_*` tools would fragment the surface for zero capability gain, so the companion deliberately ships none. If a future need genuinely cannot be expressed through the canonical tools, that is the bar for adding one.
