import type { McpToolDefinition } from "../types.js";

export const getContextTool: McpToolDefinition = {
  name: "statewave_get_context",
  description:
    "Retrieve compact, ranked context for a subject. Use this in agent prompts instead of stuffing raw chat history.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      subject: { type: "string" },
      query: { type: "string", description: "Optional question or focus to bias the context" },
      max_tokens: { type: "integer", minimum: 100, maximum: 32000, default: 2000 },
    },
    additionalProperties: false,
  },
};
