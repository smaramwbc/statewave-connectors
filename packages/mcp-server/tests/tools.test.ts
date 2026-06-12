import { describe, it, expect } from "vitest";
import { STATEWAVE_MCP_TOOLS, listTools } from "../src/index.js";

describe("MCP tools", () => {
  it("exposes the canonical tools (incl. list_subjects for subject discovery)", () => {
    const names = STATEWAVE_MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "statewave_compile_subject",
        "statewave_get_context",
        "statewave_get_timeline",
        "statewave_ingest_episode",
        "statewave_list_subjects",
        "statewave_search_memories",
      ].sort(),
    );
  });

  it("each tool has a description and an object input schema", () => {
    for (const t of listTools()) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
    }
  });
});
