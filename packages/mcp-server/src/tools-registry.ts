import { compileSubjectTool } from "./tools/compile-subject.js";
import { getContextTool } from "./tools/get-context.js";
import { getTimelineTool } from "./tools/get-timeline.js";
import { ingestEpisodeTool } from "./tools/ingest-episode.js";
import { listSubjectsTool } from "./tools/list-subjects.js";
import { searchMemoriesTool } from "./tools/search-memories.js";
import type { McpToolDefinition } from "./types.js";

export const STATEWAVE_MCP_TOOLS: ReadonlyArray<McpToolDefinition> = [
  ingestEpisodeTool,
  searchMemoriesTool,
  getContextTool,
  getTimelineTool,
  compileSubjectTool,
  listSubjectsTool,
];
