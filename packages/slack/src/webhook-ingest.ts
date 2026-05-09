// Minimal "send this episode to Statewave" client used by the webhook
// handler. The MCP server's StatewaveClient already does this, but we
// don't want @statewavedev/connectors-slack to depend on
// @statewavedev/mcp-server — this module is intentionally local and
// duplicates ~30 lines of wire-format translation. If a third connector
// grows the same need, this is a candidate to lift into
// @statewavedev/connectors-core as a shared helper.

import { ConnectorError, type StatewaveEpisode } from "@statewavedev/connectors-core";

export interface IngestClientOptions {
  url: string;
  apiKey?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
}

export type StatewaveIngest = (episode: StatewaveEpisode) => Promise<void>;

/**
 * Build the default ingest function — POSTs the episode to
 * `${url}/v1/episodes` with the wire-shape the server expects (subject_id,
 * type, source as string, payload object). `occurred_at` rides at the
 * top level since server migration 0015.
 */
export function createDefaultIngest(options: IngestClientOptions): StatewaveIngest {
  if (!options.url) {
    throw new ConnectorError("ingest URL is required", {
      code: "config_invalid",
      connector: "slack",
    });
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new ConnectorError("global fetch is unavailable; pass fetchImpl", {
      code: "config_invalid",
      connector: "slack",
    });
  }
  const baseUrl = options.url.replace(/\/+$/, "");

  return async (episode: StatewaveEpisode): Promise<void> => {
    const wire = {
      subject_id: episode.subject,
      type: episode.kind,
      source: episode.source.type,
      occurred_at: episode.occurred_at,
      payload: {
        text: episode.text,
        ...(episode.source.id ? { source_id: episode.source.id } : {}),
        ...(episode.source.url ? { source_url: episode.source.url } : {}),
      },
      metadata: {
        ...(episode.metadata ?? {}),
        idempotency_key: episode.idempotency_key,
      },
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (options.apiKey) headers["X-API-Key"] = options.apiKey;
    if (options.tenantId) headers["X-Tenant-ID"] = options.tenantId;

    const res = await fetchImpl(`${baseUrl}/v1/episodes`, {
      method: "POST",
      headers,
      body: JSON.stringify(wire),
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new ConnectorError(
        `slack-webhook ingest failed: HTTP ${res.status} ${text}`,
        {
          code: res.status === 401 || res.status === 403 ? "auth_failed" : "ingest_failed",
          connector: "slack",
          retryable: res.status >= 500,
        },
      );
    }
  };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
