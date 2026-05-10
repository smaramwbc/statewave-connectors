// Single ingest sink the runner uses for everything it produces —
// pull-mode episodes AND push-mode receiver output. Wraps the v1
// `/v1/episodes` HTTP API.
//
// The push-mode receivers each accept their own `ingest` callback in
// their factory config; the runner injects this implementation into
// every receiver it instantiates so all episode traffic flows through
// one place. Pull-mode connectors call `connector.sync()` and emit
// episodes via the sync result; the runner posts them through the
// same sink.

import type { StatewaveEpisode } from "@statewavedev/connectors-core";
import type { StatewaveServerConfig } from "@statewavedev/connectors-config";

export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

export interface CreateIngestOptions {
  statewave: StatewaveServerConfig;
  /** Inject `fetch` for tests / non-Node runtimes. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the HTTP ingest sink. Throws on construction if `url` is empty
 * — the caller already validated the config, so this is a defensive
 * guard rather than the canonical error site.
 */
export function createHttpIngest(options: CreateIngestOptions): StatewaveIngest {
  const url = options.statewave.url.replace(/\/$/, "");
  if (!url) throw new Error("ingest: statewave.url is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return async (episode: StatewaveEpisode) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.statewave.api_key) {
      headers.authorization = `Bearer ${options.statewave.api_key}`;
    }
    if (options.statewave.tenant_id) {
      headers["x-statewave-tenant-id"] = options.statewave.tenant_id;
    }
    const res = await fetchImpl(`${url}/v1/episodes`, {
      method: "POST",
      headers,
      body: JSON.stringify(episode),
    });
    if (!res.ok) {
      throw new Error(`statewave ingest returned HTTP ${res.status}`);
    }
  };
}
