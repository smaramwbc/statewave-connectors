import {
  ConnectorError,
  type StatewaveEpisode,
} from "@statewavedev/connectors-core";
import { StatewaveClient } from "@statewavedev/mcp-server";
import type { IdeCompanionConfig, IngestOutcome } from "./types.js";

/**
 * Reuse the existing Statewave HTTP client from `@statewavedev/mcp-server`
 * rather than writing a parallel one. It already translates the
 * connectors-core `StatewaveEpisode` shape to the v1 wire format and maps
 * HTTP failures to typed `ConnectorError`s.
 */
export function createIngestClient(
  config: Pick<IdeCompanionConfig, "url" | "apiKey">,
): StatewaveClient {
  if (!config.url) {
    throw new ConnectorError(
      "Statewave URL is not configured; refusing to ingest",
      {
        code: "config_invalid",
        hint: "set `statewave.url` (and `statewave.apiKey`) or keep dry-run / autoIndex off",
      },
    );
  }
  return new StatewaveClient({
    url: config.url,
    apiKey: config.apiKey,
    userAgent: "statewave-ide-companion",
  });
}

function histogram(episodes: ReadonlyArray<StatewaveEpisode>): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const ep of episodes) kinds[ep.kind] = (kinds[ep.kind] ?? 0) + 1;
  return kinds;
}

/**
 * Map episodes to Statewave.
 *
 * `dryRun: true` is honoured before anything touches the network — nothing is
 * sent, the outcome describes exactly what *would* be sent. This is the
 * default the extension uses for a first run, and the only behaviour when
 * `autoIndex` is off.
 */
export async function ingestEpisodes(
  episodes: ReadonlyArray<StatewaveEpisode>,
  options: {
    dryRun: boolean;
    client?: StatewaveClient;
  },
): Promise<IngestOutcome> {
  const kinds = histogram(episodes);

  if (options.dryRun) {
    return {
      dryRun: true,
      attempted: episodes.length,
      ingested: 0,
      failed: 0,
      kinds,
    };
  }

  if (!options.client) {
    throw new ConnectorError("ingest requested without a configured client", {
      code: "config_invalid",
      hint: "pass a StatewaveClient from createIngestClient(config)",
    });
  }

  let ingested = 0;
  let failed = 0;
  let errorSample: string | undefined;

  for (const ep of episodes) {
    try {
      await options.client.ingestEpisode(ep);
      ingested += 1;
    } catch (err) {
      failed += 1;
      if (!errorSample) {
        errorSample = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    dryRun: false,
    attempted: episodes.length,
    ingested,
    failed,
    kinds,
    errorSample,
  };
}
