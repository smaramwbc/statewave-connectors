import type { McpToolDefinition } from "../types.js";

export const compileSubjectTool: McpToolDefinition = {
  name: "statewave_compile_subject",
  description:
    "Trigger Statewave to compile durable memories for a subject from its accumulated episodes. Returns a compile job summary.",
  inputSchema: {
    type: "object",
    required: ["subject"],
    properties: {
      subject: { type: "string" },
      force: { type: "boolean", default: false, description: "Recompile even if no new episodes" },
    },
    additionalProperties: false,
  },
};
