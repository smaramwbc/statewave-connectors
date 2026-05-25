import type { McpToolDefinition } from "../types.js";

export const getContextTool: McpToolDefinition = {
  name: "statewave_get_context",
  description:
    "Retrieve compact, ranked context for a subject. Use this in agent prompts instead of stuffing raw chat history.",
  inputSchema: {
    type: "object",
    required: ["subject", "query"],
    properties: {
      subject: { type: "string" },
      query: {
        type: "string",
        description: "The task being performed — used to rank facts and procedures",
      },
      max_tokens: { type: "integer", minimum: 100, maximum: 32000, default: 2000 },
    },
    additionalProperties: false,
  },
};
