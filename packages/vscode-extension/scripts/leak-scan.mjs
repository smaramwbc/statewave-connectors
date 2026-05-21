/**
 * Release gate: assert the VSIX would contain no source, source maps,
 * node_modules, secrets, or internal release docs. Uses `vsce ls` (lists
 * exactly what would be packaged) so it never has to parse a zip.
 *
 * Exits non-zero on any leak — wired into `pnpm run preview-release`.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vsceBin = require.resolve("@vscode/vsce/vsce");

let out;
try {
  out = execFileSync(process.execPath, [vsceBin, "ls", "--no-dependencies"], {
    encoding: "utf8",
  });
} catch (err) {
  console.error("leak-scan: `vsce ls` failed:\n" + (err.stdout || err.message));
  process.exit(2);
}

const files = out
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

const FORBIDDEN = [
  { re: /(^|\/)src\//, why: "source" },
  { re: /\.ts$/, why: "TypeScript source" },
  { re: /\.map$/, why: "source map" },
  { re: /(^|\/)node_modules\//, why: "node_modules" },
  { re: /(^|\/)tests?\//, why: "tests" },
  { re: /(^|\/)scripts\//, why: "build scripts" },
  { re: /\.tsbuildinfo$/, why: "tsbuildinfo" },
  { re: /(^|\/)\.env/i, why: "env/secret file" },
  { re: /\.(pem|key|p12|pfx)$/i, why: "key material" },
  { re: /tsconfig\.json$/, why: "tsconfig" },
  { re: /MARKETPLACE_(READINESS|ASSETS)\.md$/, why: "internal release doc" },
  { re: /PREVIEW_RELEASE_CHECKLIST\.md$/, why: "internal release doc" },
  { re: /(^|\/)(SMOKE_TEST|PR_BODY)\.md$/, why: "internal process doc" },
  { re: /\.vsix$/, why: "nested vsix" },
];

const leaks = [];
for (const f of files) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(f)) leaks.push(`${f}  (${rule.why})`);
  }
}

console.log(`leak-scan: ${files.length} file(s) would be packaged.`);
if (leaks.length > 0) {
  console.error("leak-scan: FORBIDDEN entries found:\n  " + leaks.join("\n  "));
  process.exit(1);
}
console.log("leak-scan: CLEAN — no source/maps/node_modules/secrets/internal docs.");
