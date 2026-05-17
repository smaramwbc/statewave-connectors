import { describe, it, expect } from "vitest";
import {
  classifyFile,
  isIgnored,
  isArchitectureDoc,
  isDocLike,
} from "../src/index.js";

describe("classifyFile", () => {
  it("recognises key manifests", () => {
    expect(classifyFile("README.md")).toBe("readme");
    expect(classifyFile("package.json")).toBe("node-manifest");
    expect(classifyFile("pnpm-workspace.yaml")).toBe("workspace-manifest");
    expect(classifyFile("tsconfig.base.json")).toBe("tsconfig");
    expect(classifyFile("pyproject.toml")).toBe("python-manifest");
    expect(classifyFile("Dockerfile")).toBe("dockerfile");
    expect(classifyFile("docker-compose.yml")).toBe("compose");
    expect(classifyFile("compose.prod.yaml")).toBe("compose");
  });

  it("classifies decision docs over generic docs", () => {
    expect(classifyFile("docs/adrs/0001-use-pnpm.md")).toBe("adr");
    expect(classifyFile("docs/ADR-0042-licensing.md")).toBe("adr");
    expect(classifyFile("docs/rfcs/0007-protocol.md")).toBe("rfc");
    expect(classifyFile("decisions/auth.md")).toBe("decision");
    expect(classifyFile("docs/architecture/overview.md")).toBe("decision");
    expect(classifyFile("docs/intro.md")).toBe("doc");
  });

  it("classifies tests, config, and source", () => {
    expect(classifyFile("packages/core/tests/x.test.ts")).toBe("test");
    expect(classifyFile("src/foo.spec.tsx")).toBe("test");
    expect(classifyFile("vite.config.ts")).toBe("config");
    expect(classifyFile("src/index.ts")).toBe("source");
    expect(classifyFile("main.py")).toBe("source");
    expect(classifyFile("assets/logo.png")).toBe("other");
  });

  it("doc/architecture predicates", () => {
    expect(isArchitectureDoc(classifyFile("docs/adrs/1.md"))).toBe(true);
    expect(isArchitectureDoc(classifyFile("docs/intro.md"))).toBe(false);
    expect(isDocLike(classifyFile("README.md"))).toBe(true);
    expect(isDocLike(classifyFile("src/index.ts"))).toBe(false);
  });
});

describe("isIgnored", () => {
  it("ignores default dirs and lockfiles", () => {
    expect(isIgnored("node_modules/lib/index.js")).toBe(true);
    expect(isIgnored("dist/index.js")).toBe(true);
    expect(isIgnored(".git/config")).toBe(true);
    expect(isIgnored("pnpm-lock.yaml")).toBe(true);
    expect(isIgnored("src/index.ts")).toBe(false);
  });

  it("includeGlobs force-include wins over default ignore", () => {
    expect(
      isIgnored("dist/keep/important.js", { includeGlobs: ["dist/keep/**"] }),
    ).toBe(false);
    expect(isIgnored("dist/other/x.js", { includeGlobs: ["dist/keep/**"] })).toBe(
      true,
    );
  });

  it("excludeGlobs drop matching paths", () => {
    expect(isIgnored("src/secret.ts", { excludeGlobs: ["**/secret.ts"] })).toBe(
      true,
    );
    expect(isIgnored("src/index.ts", { excludeGlobs: ["**/secret.ts"] })).toBe(
      false,
    );
  });
});
