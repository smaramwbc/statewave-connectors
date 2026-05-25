import type { McpToolDefinition } from "../types.js";

export const searchMemoriesTool: McpToolDefinition = {
  name: "statewave_search_memories",
  description:
    "Search compiled Statewave memories. Returns ranked memories — not raw episodes — for a subject and free-text query.",
  inputSchema: {
    type: "object",
    required: ["query", "subject"],
    properties: {
      query: { type: "string" },
      subject: {
        type: "string",
        description: "Subject the search is scoped to — the Statewave server requires it",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
    additionalProperties: false,
  },
};
