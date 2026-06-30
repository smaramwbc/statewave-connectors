import type { McpToolDefinition } from "../types.js";

export const getTimelineTool: McpToolDefinition = {
  name: "statewave_get_timeline",
  description:
    "Retrieve a subject's raw episodes in chronological order (oldest to newest). Read-only. " +
    "Unlike statewave_search_memories (ranked, compiled memories), this returns the underlying event log " +
    "unmodified — use it for audit trails, change-logs, debugging what was ingested, or replaying history. " +
    "Optionally bound the window with `since`/`until` and filter to specific event `kinds`. " +
    "Returns an array of episode records (id, kind, text, occurred_at, source), capped by `limit`; an empty " +
    "array means no episodes matched the filters.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      subject: {
        type: "string",
        description:
          "Subject whose episodes to list. Format `scope:identifier`, e.g. `repo:owner.name` or " +
          "`customer:acme`.",
        pattern: "^[A-Za-z0-9_.:-]+$",
      },
      since: {
        type: "string",
        format: "date-time",
        description:
          "Optional inclusive lower time bound: only episodes with occurred_at at or after this ISO 8601 " +
          "timestamp are returned, e.g. `2026-06-01T00:00:00Z`.",
      },
      until: {
        type: "string",
        format: "date-time",
        description:
          "Optional exclusive upper time bound: only episodes with occurred_at strictly before this ISO " +
          "8601 timestamp are returned.",
      },
      kinds: {
        type: "array",
        description:
          "Optional list of event kinds to include (e.g. `[\"github.issue.opened\", \"chat.note\"]`). " +
          "When omitted, all kinds are returned.",
        items: { type: "string", description: "An event kind to include in the results." },
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        default: 100,
        description: "Maximum number of episodes to return (1–500, default 100).",
      },
    },
    additionalProperties: false,
  },
};
