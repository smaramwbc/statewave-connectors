import type { StatewaveEpisode } from "./episode.js";
import type { SyncSummary } from "./connector.js";

export function summarizeEpisodes(
  episodes: ReadonlyArray<StatewaveEpisode>,
  details?: Record<string, number>,
): SyncSummary {
  const kinds: Record<string, number> = {};
  for (const ep of episodes) {
    kinds[ep.kind] = (kinds[ep.kind] ?? 0) + 1;
  }
  return {
    total: episodes.length,
    kinds,
    details,
  };
}
