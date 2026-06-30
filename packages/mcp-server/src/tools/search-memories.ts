import type { McpToolDefinition } from "../types.js";

export const searchMemoriesTool: McpToolDefinition = {
  name: "statewave_search_memories",
  description:
    "Search a subject's compiled, durable memories by free-text query and return the most relevant ones, " +
    "ranked by relevance. Read-only. This searches distilled memories, NOT raw episodes — newly ingested " +
    "episodes only appear here after statewave_compile_subject has run. " +
    "Returns an array of memory records (id, subject, kind, content) ordered most-relevant first; an empty " +
    "array means nothing matched. " +
    "Use it to look up specific remembered facts; prefer statewave_get_context when you instead want " +
    "prompt-ready context assembled to a token budget.",
  inputSchema: {
    type: "object",
    required: ["query", "subject"],
    properties: {
      query: {
        type: "string",
        description:
          "Free-text search query — keywords, a question, or a topic to match against the subject's " +
          "compiled memories.",
      },
      subject: {
        type: "string",
        description:
          "Subject to scope the search to (required by the server). Format `scope:identifier`, e.g. " +
          "`repo:owner.name` or `customer:acme`.",
        pattern: "^[A-Za-z0-9_.:-]+$",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 10,
        description: "Maximum number of ranked memories to return (1–50, default 10).",
      },
    },
    additionalProperties: false,
  },
};
