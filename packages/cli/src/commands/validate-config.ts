// `statewave-connectors validate-config [--config <path>]`
//
// Loads the runner config (the file `run` will use in Wave 2), reports
// every problem in one pass, and exits non-zero on the first failure
// mode it hits. No network calls, no daemon — purely a static check
// that the config is well-formed and every `${VAR}` reference resolves.

import { ConfigError, loadConfig } from "@statewavedev/connectors-config";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";

export async function runValidateConfig(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const configPath = flagAsString(args, "config");

  try {
    const loaded = await loadConfig({
      ...(configPath ? { configPath } : {}),
    });
    const summary = summarize(loaded.config);
    if (out.isJson()) {
      out.data({
        ok: true,
        path: loaded.path,
        source: loaded.source,
        summary,
      });
    } else {
      out.log(`✓ config OK`);
      out.log(`  path:     ${loaded.path ?? "(stdin)"}`);
      out.log(`  source:   ${loaded.source}`);
      out.log(`  statewave: ${loaded.config.statewave.url}`);
      if (summary.pull.length > 0) {
        out.log(`  pull:`);
        for (const line of summary.pull) out.log(`    ${line}`);
      }
      if (summary.push.length > 0) {
        out.log(`  push:`);
        for (const line of summary.push) out.log(`    ${line}`);
      }
    }
    return 0;
  } catch (err) {
    return reportError(out, err);
  }
}

interface Summary {
  pull: ReadonlyArray<string>;
  push: ReadonlyArray<string>;
}

function summarize(
  config: Awaited<ReturnType<typeof loadConfig>>["config"],
): Summary {
  const pull: string[] = [];
  for (const [kind, entries] of Object.entries(config.pull)) {
    if (!entries) continue;
    for (const e of entries) {
      pull.push(`${kind}/${e.name}  (${e.schedule})`);
    }
  }
  const push: string[] = [];
  for (const [kind, entries] of Object.entries(config.push)) {
    if (!entries) continue;
    for (const e of entries) {
      push.push(`${kind}/${e.name}  → /${kind}/${e.name}/events`);
    }
  }
  return { pull, push };
}

function reportError(out: Output, err: unknown): number {
  if (!(err instanceof ConfigError)) {
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (out.isJson()) {
    out.data({
      ok: false,
      code: err.code,
      message: err.message,
      issues: err.issues,
      missing: err.missing,
      searched: err.searched,
    });
    return errorExitCode(err.code);
  }

  switch (err.code) {
    case "not_found":
      out.error(err.message, "");
      if (err.searched.length > 0) {
        out.log("  Searched:");
        for (const s of err.searched) out.log(`    [${s.source}] ${s.path}`);
      }
      out.log(
        "  Pass --config <path>, set STATEWAVE_CONNECTORS_CONFIG, or create ./statewave-connectors.toml",
      );
      break;
    case "parse_error":
      out.error(err.message);
      break;
    case "missing_env":
      out.error(`${err.missing.length} env var(s) referenced in config but not set:`);
      for (const v of err.missing) out.log(`  - ${v}`);
      break;
    case "validation_error":
      out.error(`${err.issues.length} validation issue(s):`);
      for (const issue of err.issues) {
        out.log(`  - ${issue.path}: ${issue.message}`);
      }
      break;
  }
  return errorExitCode(err.code);
}

function errorExitCode(code: ConfigError["code"]): number {
  // 2 for "user can fix this by editing the config or env";
  // 1 for unexpected internal failure.
  if (code === "not_found" || code === "missing_env" || code === "validation_error") {
    return 2;
  }
  return 1;
}
