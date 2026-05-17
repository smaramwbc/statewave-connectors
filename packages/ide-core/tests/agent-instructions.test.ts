import { describe, it, expect } from "vitest";
import {
  buildAgentInstruction,
  wrapForClient,
  mergeMarkedBlock,
  AGENT_INSTRUCTION_TARGETS,
  STATEWAVE_BEGIN,
  STATEWAVE_END,
} from "../src/index.js";

describe("buildAgentInstruction", () => {
  it("read-write includes both the read and the persist directive", () => {
    const t = buildAgentInstruction({ subject: "repo:acme.widgets", mode: "read-write" });
    expect(t).toContain("statewave_get_context");
    expect(t).toContain("repo:acme.widgets");
    expect(t).toContain("statewave_ingest_episode");
    expect(t).toContain("favorite color is red");
    expect(t).toContain("chat.note");
    // must also tell it to compile, or the episode never becomes memory
    expect(t).toContain("statewave_compile_subject");
  });

  it("read-only omits the persist + compile directives", () => {
    const t = buildAgentInstruction({ subject: "repo:acme.widgets", mode: "read-only" });
    expect(t).toContain("statewave_get_context");
    expect(t).not.toContain("statewave_ingest_episode");
    expect(t).not.toContain("statewave_compile_subject");
  });
});

describe("wrapForClient", () => {
  it("applies the correct frontmatter per client", () => {
    const body = "BODY";
    expect(wrapForClient("cursor", body)).toBe("---\nalwaysApply: true\n---\n\nBODY\n");
    expect(wrapForClient("windsurf", body)).toBe("---\ntrigger: always_on\n---\n\nBODY\n");
    expect(wrapForClient("continue", body)).toContain("name: Statewave Project Memory");
    expect(wrapForClient("cline", body)).toBe("BODY\n"); // plain markdown
    expect(wrapForClient("roo", body)).toBe("BODY\n");
  });
});

describe("mergeMarkedBlock", () => {
  it("appends a delimited block to a file with user content, preserving it", () => {
    const existing = "# My CLAUDE.md\n\nMy own rules.\n";
    const { content, changed } = mergeMarkedBlock(existing, "STATEWAVE BODY");
    expect(changed).toBe(true);
    expect(content.startsWith("# My CLAUDE.md")).toBe(true);
    expect(content).toContain("My own rules.");
    expect(content).toContain(STATEWAVE_BEGIN);
    expect(content).toContain("STATEWAVE BODY");
    expect(content).toContain(STATEWAVE_END);
  });

  it("replaces only the block on update and is idempotent", () => {
    const first = mergeMarkedBlock("user stuff\n", "V1").content;
    const second = mergeMarkedBlock(first, "V2");
    expect(second.changed).toBe(true);
    expect(second.content).toContain("V2");
    expect(second.content).not.toContain("V1");
    expect(second.content.startsWith("user stuff")).toBe(true);
    // idempotent: same body → no change
    expect(mergeMarkedBlock(second.content, "V2").changed).toBe(false);
  });

  it("handles an empty/absent file", () => {
    const { content, changed } = mergeMarkedBlock("", "BODY");
    expect(changed).toBe(true);
    expect(content).toContain(STATEWAVE_BEGIN);
    expect(content).toContain("BODY");
  });
});

describe("AGENT_INSTRUCTION_TARGETS", () => {
  it("covers all 7 clients with correct strategy", () => {
    const byId = Object.fromEntries(
      AGENT_INSTRUCTION_TARGETS.map((t) => [t.client, t]),
    );
    expect(byId["copilot"]!.relativePath).toBe(".github/copilot-instructions.md");
    expect(byId["copilot"]!.strategy).toBe("merge");
    expect(byId["claude"]!.relativePath).toBe("CLAUDE.md");
    expect(byId["claude"]!.strategy).toBe("merge");
    expect(byId["cursor"]!.relativePath).toBe(".cursor/rules/statewave.mdc");
    expect(byId["cursor"]!.strategy).toBe("own");
    expect(byId["roo"]!.relativePath).toBe(".roo/rules/statewave.md");
    expect(AGENT_INSTRUCTION_TARGETS).toHaveLength(7);
  });
});
