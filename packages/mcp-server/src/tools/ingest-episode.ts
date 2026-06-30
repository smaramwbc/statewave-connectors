import type { McpToolDefinition } from "../types.js";

export const ingestEpisodeTool: McpToolDefinition = {
  name: "statewave_ingest_episode",
  description:
    "Write a single normalized event ('episode') into Statewave's raw memory log for a subject. " +
    "This is a write: the episode is stored immediately but is NOT yet retrievable as durable memory — " +
    "call statewave_compile_subject afterward to distil episodes into the compiled memories that " +
    "statewave_get_context and statewave_search_memories read. Idempotent: re-ingesting an " +
    "idempotency_key already seen for the subject does not create a duplicate. " +
    "Returns the stored episode id, its idempotency_key, and a `duplicate` boolean indicating whether " +
    "an existing episode was matched. " +
    "Use it to capture a durable fact, decision, message, or system event you want remembered.",
  inputSchema: {
    type: "object",
    required: ["subject", "kind", "text", "occurred_at", "source", "idempotency_key"],
    properties: {
      subject: {
        type: "string",
        description:
          "Memory subject the episode belongs to, as `scope:identifier` using only letters, digits, " +
          "and the characters . _ - : (no slashes). Examples: `repo:owner.name`, `customer:acme`, " +
          "`workspace:team`.",
        pattern: "^[A-Za-z0-9_.:-]+$",
      },
      kind: {
        type: "string",
        description:
          "Event type in dotted lowercase namespace form, used to group and filter episodes. " +
          "Examples: `github.issue.opened`, `chat.note`, `deploy.succeeded`.",
      },
      text: {
        type: "string",
        description:
          "Human-readable content of the event — the fact, note, or message to remember. " +
          "This is the primary text distilled into compiled memory.",
      },
      occurred_at: {
        type: "string",
        format: "date-time",
        description:
          "When the event actually occurred, as an ISO 8601 / RFC 3339 timestamp, e.g. " +
          "`2026-06-30T15:00:00Z`.",
      },
      source: {
        type: "object",
        description: "Provenance of the episode — where it originated.",
        required: ["type", "id"],
        properties: {
          type: {
            type: "string",
            description: "Source system or channel, e.g. `github`, `slack`, `chat`, `web`.",
          },
          id: {
            type: "string",
            description:
              "Stable identifier of the item within the source system, e.g. an issue number, " +
              "message id, or URL slug.",
          },
          url: {
            type: "string",
            description: "Optional canonical link back to the source item.",
          },
        },
      },
      metadata: {
        type: "object",
        additionalProperties: true,
        description:
          "Optional free-form key/value object for structured attributes (labels, ids, scores) " +
          "carried alongside the episode.",
      },
      idempotency_key: {
        type: "string",
        description:
          "Caller-supplied unique key for this episode. Re-ingesting the same key for the same subject " +
          "is a no-op (deduplicated), so retries are safe.",
      },
    },
    additionalProperties: false,
  },
};
