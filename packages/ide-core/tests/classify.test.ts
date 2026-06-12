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

  it("ignores editor atomic-save and swap files", () => {
    // VS Code atomic save artifacts that doubled every save event.
    expect(isIgnored(".vscode/settings.json.tmp.76262.7dac643edf04")).toBe(true);
    expect(isIgnored("client/src/Foo.tsx.tmp.79326.fd858c66695b")).toBe(true);
    expect(isIgnored("api/routes/raapi.js.tmp.80393.b8cf98d894ac")).toBe(true);
    // Vim / Emacs swap + lock files.
    expect(isIgnored("src/.foo.ts.swp")).toBe(true);
    expect(isIgnored("src/.foo.ts.swo")).toBe(true);
    expect(isIgnored("src/.#foo.ts")).toBe(true);
    // Don't over-match the real file.
    expect(isIgnored("src/foo.ts")).toBe(false);
  });

  it("ignores embedded-DB runtime data files (WiredTiger, LMDB, Meilisearch)", () => {
    expect(isIgnored("data-node/WiredTiger.wt")).toBe(true);
    expect(isIgnored("data-node/WiredTiger.lock")).toBe(true);
    expect(isIgnored("data-node/journal/WiredTigerPreplog.0000000001")).toBe(true);
    expect(isIgnored("data-node/collection-2-12345.wt")).toBe(true);
    expect(isIgnored("meili_data_v1.12/data.ms/auth/data.mdb")).toBe(true);
    expect(isIgnored("meili_data_v1.12/data.ms/auth/lock.mdb")).toBe(true);
    expect(isIgnored("data-node/mongod.lock")).toBe(true);
  });

  it("ignores common Docker-Compose DB volume dirs (including versioned)", () => {
    expect(isIgnored("data-node/anything.txt")).toBe(true);
    expect(isIgnored("mongo-data/file.bson")).toBe(true);
    expect(isIgnored("mongodb_data/anything")).toBe(true);
    expect(isIgnored("pg-data/anything")).toBe(true);
    expect(isIgnored("pgdata/anything")).toBe(true);
    expect(isIgnored("postgres-data/file")).toBe(true);
    expect(isIgnored("mysql-data/file")).toBe(true);
    expect(isIgnored("redis-data/file")).toBe(true);
    expect(isIgnored("elasticsearch-data/file")).toBe(true);
    expect(isIgnored("meili_data/file")).toBe(true);
    expect(isIgnored("meili_data_v1.12/file")).toBe(true);
    // Don't over-match user-content dirs that merely contain "data".
    expect(isIgnored("src/data/seed.json")).toBe(false);
    expect(isIgnored("docs/datasets/x.md")).toBe(false);
  });
});
