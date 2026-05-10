// Pick the right cursor store from a `[runner.state]` config block.
//
// The runner calls this at boot if the embedder didn't provide its own
// `cursorStore` override. Embedders (someone wiring the runner into
// their own service) usually instantiate a store directly and skip
// this — the selector exists so the CLI's `run` command can stay a
// thin wrapper.

import path from "node:path";
import type { RunnerConfig, RunnerStateConfig } from "@statewavedev/connectors-config";
import { openFileBackedPullCursorStore } from "./file.js";
import { InMemoryPullCursorStore } from "./in-memory.js";
import { openPostgresPullCursorStore } from "./postgres.js";
import { openRedisPullCursorStore } from "./redis.js";
import type { PullCursorStore } from "./types.js";

export interface SelectStateOptions {
  /** The runner block from the loaded config — supplies `state` and
   * the `state_dir` default for the file adapter. */
  runner: RunnerConfig;
  /** Working directory used to resolve relative paths in the file
   * adapter. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Resolve and instantiate the configured store. When `[runner.state]`
 * is omitted, defaults to in-memory (matches the Wave 2 behaviour so
 * existing operators don't see a behaviour change on upgrade).
 */
export async function selectPullCursorStore(
  options: SelectStateOptions,
): Promise<PullCursorStore> {
  const cwd = options.cwd ?? process.cwd();
  const state: RunnerStateConfig = options.runner.state ?? { kind: "memory" };
  switch (state.kind) {
    case "memory":
      return new InMemoryPullCursorStore();
    case "file": {
      const stateDir = options.runner.state_dir ?? "./var/connectors-state";
      const filePath = path.resolve(cwd, state.path ?? path.join(stateDir, "cursors.json"));
      return openFileBackedPullCursorStore({ path: filePath });
    }
    case "postgres":
      return openPostgresPullCursorStore({
        url: state.url,
        ...(state.table ? { table: state.table } : {}),
      });
    case "redis":
      return openRedisPullCursorStore({
        url: state.url,
        ...(state.key_prefix ? { key_prefix: state.key_prefix } : {}),
      });
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown state kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
