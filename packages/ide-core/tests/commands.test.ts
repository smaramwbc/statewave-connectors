import { describe, it, expect } from "vitest";
import {
  parseProjectCommands,
  projectCommandsEpisode,
  type ProjectCommand,
} from "../src/index.js";

const SUBJECT = "repo:acme/widgets";
const base = {
  subject: SUBJECT,
  redactionEnabled: false,
  occurredAt: "2026-02-02T00:00:00.000Z",
};

describe("parseProjectCommands", () => {
  it("reads package.json scripts", () => {
    const out = parseProjectCommands({
      packageJson: JSON.stringify({
        name: "x",
        scripts: { test: "vitest run", build: "tsc -p .", lint: 42 },
      }),
    });
    expect(out).toEqual([
      { source: "package.json", name: "test", command: "vitest run" },
      { source: "package.json", name: "build", command: "tsc -p ." },
    ]);
  });

  it("ignores malformed package.json", () => {
    expect(parseProjectCommands({ packageJson: "{not json" })).toEqual([]);
    expect(parseProjectCommands({ packageJson: "[]" })).toEqual([]);
  });

  it("reads Makefile targets and skips dotted/assignment lines", () => {
    const makefile = [
      ".PHONY: build test",
      "CC := gcc",
      "build:",
      "\tgo build ./...",
      "test: build",
      "\tgo test ./...",
      "build:", // duplicate — only the first wins
      "\techo again",
    ].join("\n");
    const out = parseProjectCommands({ makefile });
    expect(out).toEqual([
      { source: "Makefile", name: "build", command: "make build" },
      { source: "Makefile", name: "test", command: "make test" },
    ]);
  });

  it("reads pyproject [project.scripts] and [tool.poetry.scripts] only", () => {
    const pyproject = [
      "[project]",
      'name = "x"',
      'version = "1.0"',
      "",
      "[project.scripts]",
      'serve = "x.cli:serve"',
      'worker = "x.cli:worker"',
      "",
      "[tool.poetry.scripts]",
      'legacy = "x.legacy:main"',
      "",
      "[tool.black]",
      'line-length = "88"',
    ].join("\n");
    const out = parseProjectCommands({ pyproject });
    expect(out).toEqual([
      { source: "pyproject.toml", name: "serve", command: "x.cli:serve" },
      { source: "pyproject.toml", name: "worker", command: "x.cli:worker" },
      { source: "pyproject.toml", name: "legacy", command: "x.legacy:main" },
    ]);
  });

  it("merges all three manifests", () => {
    const out = parseProjectCommands({
      packageJson: JSON.stringify({ scripts: { test: "vitest" } }),
      makefile: "build:\n\tgo build",
      pyproject: '[project.scripts]\nserve = "x:serve"',
    });
    expect(out.map((c) => c.source)).toEqual([
      "package.json",
      "Makefile",
      "pyproject.toml",
    ]);
  });
});

describe("projectCommandsEpisode", () => {
  const commands: ProjectCommand[] = [
    { source: "package.json", name: "test", command: "vitest run" },
    { source: "Makefile", name: "build", command: "make build" },
  ];

  it("produces the ide.project.commands kind and lists commands", () => {
    const ep = projectCommandsEpisode({ ...base, commands });
    expect(ep.kind).toBe("ide.project.commands");
    expect(ep.text).toContain("vitest run");
    expect(ep.text).toContain("make build");
    expect(ep.metadata?.command_count).toBe(2);
    expect((ep.metadata?.by_source as Record<string, number>)["package.json"]).toBe(1);
  });

  it("idempotency is content-addressable: identical declared surface → same key", () => {
    const a = projectCommandsEpisode({ ...base, commands });
    const b = projectCommandsEpisode({ ...base, commands: [...commands].reverse() });
    expect(a.idempotency_key).toBe(b.idempotency_key);

    const changed: ProjectCommand[] = [
      { source: "package.json", name: "test", command: "jest" },
    ];
    const c = projectCommandsEpisode({ ...base, commands: changed });
    expect(c.idempotency_key).not.toBe(a.idempotency_key);
  });

  it("redacts secrets in command strings when enabled", () => {
    const ep = projectCommandsEpisode({
      subject: SUBJECT,
      redactionEnabled: true,
      occurredAt: base.occurredAt,
      commands: [
        {
          source: "package.json",
          name: "deploy",
          command: "TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz0123 deploy.sh",
        },
      ],
    });
    expect(ep.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    const meta = (ep.metadata?.commands as Array<{ command: string }>)[0]!;
    expect(meta.command).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
  });
});
