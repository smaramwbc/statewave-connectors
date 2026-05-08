import type { McpToolDefinition } from "../types.js";

export const getTimelineTool: McpToolDefinition = {
  name: "statewave_get_timeline",
  description:
    "Retrieve a chronological timeline of episodes for a subject. Useful for audit, change-log, and replay use cases.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      subject: { type: "string" },
      since: { type: "string", description: "ISO 8601 timestamp" },
      until: { type: "string", description: "ISO 8601 timestamp" },
      kinds: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
    },
    additionalProperties: false,
  },
};
