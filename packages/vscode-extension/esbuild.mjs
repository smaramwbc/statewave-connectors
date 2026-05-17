/**
 * Bundle the extension into a single CommonJS file for the VS Code / Cursor
 * extension host.
 *
 * Why bundle: the extension host loads the entry as CommonJS, but
 * `@statewavedev/ide-core` (and its connectors-core / mcp-server deps) are
 * ESM-only. esbuild resolves the workspace packages through their `exports`
 * and inlines them, so the produced `.vsix` is self-contained and the only
 * runtime external is `vscode` itself (provided by the host).
 */
import { build } from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  minify: false,
  // Provided by the extension host — must never be bundled.
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const ctx = await (await import("esbuild")).context(options);
  await ctx.watch();
  console.log("esbuild: watching…");
} else {
  await build(options);
}
