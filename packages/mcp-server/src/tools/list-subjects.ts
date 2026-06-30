import type { McpToolDefinition } from "../types.js";

export const listSubjectsTool: McpToolDefinition = {
  name: "statewave_list_subjects",
  description:
    "List the memory subjects this Statewave instance knows about, with per-subject episode and memory " +
    "counts. Read-only. Use it to discover which subject id to pass to the other tools (e.g. " +
    "`repo:owner.name`) — especially in chat clients that have no repository context. " +
    "Returns a paginated array of subjects (subject id, episode_count, memory_count) plus a total count; " +
    "page through larger instances with limit/offset.",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 50,
        description: "Maximum number of subjects to return (1–200, default 50).",
      },
      offset: {
        type: "integer",
        minimum: 0,
        default: 0,
        description: "Number of subjects to skip from the start of the list, for pagination (default 0).",
      },
    },
    additionalProperties: false,
  },
};
