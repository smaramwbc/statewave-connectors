import type { McpToolDefinition } from "../types.js";

export const compileSubjectTool: McpToolDefinition = {
  name: "statewave_compile_subject",
  description:
    "Compile a subject's accumulated raw episodes into durable, retrievable memories. This is the step " +
    "that makes ingested episodes searchable: statewave_ingest_episode stores raw episodes, and this " +
    "distils them into the compiled memory that statewave_get_context and statewave_search_memories read. " +
    "Triggers a compile job on the server and returns its summary (subject and status). By default it is a " +
    "no-op when there are no new episodes since the last compile; set `force` to recompile anyway. " +
    "Call it right after ingesting episodes you want to become retrievable.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      subject: {
        type: "string",
        description:
          "Subject to compile. Format `scope:identifier`, e.g. `repo:owner.name` or `customer:acme`.",
        pattern: "^[A-Za-z0-9_.:-]+$",
      },
      force: {
        type: "boolean",
        default: false,
        description:
          "Recompile even when no new episodes have been ingested since the last compile (default false). " +
          "Use to refresh stale memory or after changing compilation settings.",
      },
    },
    additionalProperties: false,
  },
};
