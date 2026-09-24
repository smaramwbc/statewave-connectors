import { createRequire } from "node:module";

/**
 * The package version, read from package.json at runtime.
 *
 * This used to be a hardcoded constant in two places, each with a comment
 * asking whoever cut the release to bump it by hand. Nothing enforced that, so
 * both went stale: the CLI and the MCP `initialize` handshake reported 0.1.0
 * while the published package was at 0.4.8. Reading the real value means the
 * reported version cannot drift from the published one again.
 *
 * `../package.json` resolves the same way from `dist/version.js` in a
 * published install as it does from `src/version.ts` under vitest, and
 * package.json is always present in an npm tarball.
 */
const requirePackage = createRequire(import.meta.url);

export const SERVER_VERSION: string = (requirePackage("../package.json") as { version: string })
  .version;
