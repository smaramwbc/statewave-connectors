/**
 * Bundled MCP stdio server entry.
 *
 * This is a *separate* esbuild output (`dist/mcp-stdio.cjs`) that the editor
 * spawns as the Statewave MCP server. It exists so the extension is
 * self-contained: the user never runs a Docker container, never `npx`-installs
 * an unpublished package, and never hand-edits an MCP config — the plugin
 * launches this with `STATEWAVE_URL` / `STATEWAVE_API_KEY` injected from the
 * settings the user already set once.
 *
 * It just delegates to the tested `@statewavedev/mcp-server` stdio loop, which
 * reads those env vars. No new transport, no duplicate protocol code.
 */
import { startStdioServerFromEnv } from "@statewavedev/mcp-server";

startStdioServerFromEnv().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`statewave mcp-stdio fatal: ${msg}\n`);
  process.exit(1);
});
