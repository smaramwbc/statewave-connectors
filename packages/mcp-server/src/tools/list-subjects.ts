import type { McpToolDefinition } from "../types.js";

export const listSubjectsTool: McpToolDefinition = {
  name: "statewave_list_subjects",
  description:
    "List the memory subjects this Statewave instance knows about, with episode and memory counts. " +
    "Use this to discover which subject (e.g. repo:owner.name) to pass to statewave_get_context — " +
    "especially in chat clients that have no repository context. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max subjects to return (default 50, max 200)" },
      offset: { type: "number", description: "Pagination offset" },
    },
    additionalProperties: false,
  },
};
