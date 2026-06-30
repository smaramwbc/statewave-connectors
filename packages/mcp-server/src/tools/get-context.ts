import type { McpToolDefinition } from "../types.js";

export const getContextTool: McpToolDefinition = {
  name: "statewave_get_context",
  description:
    "Assemble a compact, ranked context bundle for a subject, tailored to the task described in `query`. " +
    "Read-only. Designed to be injected into an agent/LLM prompt in place of stuffing raw chat history or " +
    "whole files: it returns only the most relevant distilled facts and procedures, fit to a token budget. " +
    "Returns a context bundle with `assembled_context` (ready-to-prompt text), structured `facts` and " +
    "`procedures` arrays, and a token estimate. " +
    "Prefer this over statewave_search_memories when you want prompt-ready context rather than a raw ranked " +
    "list of memories.",
  inputSchema: {
    type: "object",
    required: ["subject", "query"],
    properties: {
      subject: {
        type: "string",
        description:
          "Subject to retrieve context for. Format `scope:identifier`, e.g. `repo:owner.name` or " +
          "`customer:acme`.",
        pattern: "^[A-Za-z0-9_.:-]+$",
      },
      query: {
        type: "string",
        description:
          "The task being performed or question being answered. Used to rank and select which facts and " +
          "procedures to include in the bundle.",
      },
      max_tokens: {
        type: "integer",
        minimum: 100,
        maximum: 32000,
        default: 2000,
        description:
          "Approximate token budget for the assembled context (100–32000, default 2000). Lower it for " +
          "tight prompts; raise it for richer context.",
      },
    },
    additionalProperties: false,
  },
};
