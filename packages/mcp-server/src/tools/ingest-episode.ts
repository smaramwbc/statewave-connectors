import type { McpToolDefinition } from "../types.js";

export const ingestEpisodeTool: McpToolDefinition = {
  name: "statewave_ingest_episode",
  description:
    "Ingest a single normalized episode into Statewave. Episodes are deduplicated on idempotency_key.",
  inputSchema: {
    type: "object",
    required: ["subject", "kind", "text", "occurred_at", "source", "idempotency_key"],
    properties: {
      subject: { type: "string", description: "Memory subject (e.g. repo:owner/name, customer:acme)" },
      kind: { type: "string", description: "Event kind (e.g. github.issue.opened)" },
      text: { type: "string" },
      occurred_at: { type: "string", description: "ISO 8601 timestamp" },
      source: {
        type: "object",
        required: ["type", "id"],
        properties: {
          type: { type: "string" },
          id: { type: "string" },
          url: { type: "string" },
        },
      },
      metadata: { type: "object", additionalProperties: true },
      idempotency_key: { type: "string" },
    },
    additionalProperties: false,
  },
};
