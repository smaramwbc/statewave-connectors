import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";

export async function runReplay(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const source = flagAsString(args, "source");
  const since = flagAsString(args, "since");

  if (!source) {
    out.error("--source is required", "example: --source github --since 2026-01-01");
    return 2;
  }

  const plan = {
    connector: source,
    since: since ?? null,
    note: "replay re-emits historical events through the connector mapper without ingesting unless STATEWAVE_URL is set and --no-dry-run is passed",
  };

  if (out.isJson()) {
    out.data(plan);
  } else {
    out.log(`replay plan for ${source} since=${since ?? "(start of history)"}`);
    out.log("  re-runs the source's read path and maps events into normalized episodes");
    out.log("  pass --dry-run (default) to preview, or --no-dry-run to ingest into Statewave");
  }
  return 0;
}
