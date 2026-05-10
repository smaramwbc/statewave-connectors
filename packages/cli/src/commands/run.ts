// `statewave-connectors run [--config <path>]`
//
// The hosted runner. Loads a TOML config, schedules every configured
// pull source, multiplexes every configured push receiver under one
// HTTP server with `/healthz` + `/readyz`, and waits for SIGTERM /
// SIGINT to shut down gracefully.
//
// This command is a thin wrapper over `@statewavedev/connectors-runner`'s
// `createRunner()` factory — anyone embedding the runner in their own
// service calls the same factory directly and manages lifecycle there.

import { ConfigError, loadConfig } from "@statewavedev/connectors-config";
import { createRunner } from "@statewavedev/connectors-runner";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";

export async function runRun(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const configPath = flagAsString(args, "config");

  let loaded;
  try {
    loaded = await loadConfig({
      ...(configPath ? { configPath } : {}),
    });
  } catch (err) {
    return reportConfigError(out, err);
  }

  let runner;
  try {
    runner = await createRunner({ config: loaded.config });
  } catch (err) {
    out.error(`runner load failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    await runner.start();
  } catch (err) {
    out.error(`runner start failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  if (!out.isJson()) {
    const desc = runner.describe();
    out.log(`statewave-connectors run`);
    out.log(`  config:     ${loaded.path ?? "(injected)"}  [${loaded.source}]`);
    out.log(`  listening:  http://${desc.bindAddress.host}:${desc.bindAddress.port}`);
    if (desc.pullSources.length > 0) {
      out.log(`  pull schedules:`);
      for (const p of desc.pullSources) {
        out.log(`    ${p.kind}/${p.name}  (${p.schedule})`);
      }
    }
    if (desc.pushReceivers.length > 0) {
      out.log(`  push receivers:`);
      for (const p of desc.pushReceivers) {
        out.log(`    ${p.kind}/${p.name}  →  ${p.path}`);
      }
    }
    out.log(`  health:     /healthz, /readyz`);
    out.log(`  Ctrl-C to stop.`);
  }

  return new Promise<number>((resolve) => {
    const stop = async (code: number): Promise<void> => {
      try {
        await runner.stop();
      } catch (err) {
        out.error(`runner stop failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve(1);
        return;
      }
      resolve(code);
    };
    process.on("SIGINT", () => void stop(0));
    process.on("SIGTERM", () => void stop(0));
  });
}

function reportConfigError(out: Output, err: unknown): number {
  if (!(err instanceof ConfigError)) {
    out.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  switch (err.code) {
    case "not_found":
      out.error(err.message);
      if (err.searched.length > 0) {
        out.log("  Searched:");
        for (const s of err.searched) out.log(`    [${s.source}] ${s.path}`);
      }
      out.log(
        "  Pass --config <path>, set STATEWAVE_CONNECTORS_CONFIG, or create ./statewave-connectors.toml",
      );
      return 2;
    case "missing_env":
      out.error(`${err.missing.length} env var(s) referenced in config but not set:`);
      for (const v of err.missing) out.log(`  - ${v}`);
      return 2;
    case "validation_error":
      out.error(`${err.issues.length} validation issue(s) — fix and re-run:`);
      for (const issue of err.issues) {
        out.log(`  - ${issue.path}: ${issue.message}`);
      }
      return 2;
    case "parse_error":
      out.error(err.message);
      return 1;
  }
}
