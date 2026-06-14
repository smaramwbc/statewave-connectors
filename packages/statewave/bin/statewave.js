#!/usr/bin/env node
// Thin alias: forwards all arguments to @statewavedev/connectors-cli.
// Exists so `npx @statewavedev/statewave quickstart` is a clean install command.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

let entry;
try {
  // Resolve via package.json (always exported) then follow the bin field.
  const pkgJsonPath = require.resolve('@statewavedev/connectors-cli/package.json');
  const pkg = require('@statewavedev/connectors-cli/package.json');
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['statewave-connectors'];
  entry = join(dirname(pkgJsonPath), binRel);
} catch {
  process.stderr.write(
    'Error: @statewavedev/connectors-cli not found.\n' +
    'Please file an issue at https://github.com/smaramwbc/statewave/issues\n'
  );
  process.exit(1);
}

const args = process.argv.slice(2);
// Default to `quickstart` when called with no subcommand or only flags,
// so `npx @statewavedev/statewave` and `npx @statewavedev/statewave --down` both work.
const forwarded = (args.length === 0 || args[0].startsWith('-'))
  ? ['quickstart', ...args]
  : args;
const result = spawnSync(process.execPath, [entry, ...forwarded], { stdio: 'inherit' });
process.exit(result.status ?? 0);
