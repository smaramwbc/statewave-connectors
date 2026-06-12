import { describe, it, expect } from "vitest";
import {
  parseRemoteUrl,
  subjectFromRemoteUrl,
  localSubject,
  discoverRepos,
  type RepoIdentity,
} from "../src/commands/repo.js";

describe("parseRemoteUrl", () => {
  const cases: Array<[string, string, string]> = [
    // [url, host, path]
    ["git@github.com:smaramwbc/statewave.git", "github.com", "smaramwbc/statewave"],
    ["https://github.com/smaramwbc/statewave.git", "github.com", "smaramwbc/statewave"],
    ["https://github.com/smaramwbc/statewave", "github.com", "smaramwbc/statewave"],
    ["git@gitlab.com:group/sub/repo.git", "gitlab.com", "group/sub/repo"], // nested subgroup
    ["https://gitlab.com/group/sub/repo.git", "gitlab.com", "group/sub/repo"],
    ["git@bitbucket.org:workspace/repo.git", "bitbucket.org", "workspace/repo"],
    ["https://gitea.example.com/owner/repo.git", "gitea.example.com", "owner/repo"],
    ["ssh://git@gitea.example.com:2222/owner/repo.git", "gitea.example.com", "owner/repo"],
    // Azure DevOps
    ["git@ssh.dev.azure.com:v3/org/project/repo", "ssh.dev.azure.com", "org/project/repo"],
    ["https://dev.azure.com/org/project/_git/repo", "dev.azure.com", "org/project/repo"],
    ["https://org@dev.azure.com/org/project/_git/repo", "dev.azure.com", "org/project/repo"],
    ["https://org.visualstudio.com/project/_git/repo", "org.visualstudio.com", "org/project/repo"],
  ];

  for (const [url, host, path] of cases) {
    it(`parses ${url}`, () => {
      expect(parseRemoteUrl(url)).toEqual({ host, path });
    });
  }

  it("returns undefined for empty / unparseable input", () => {
    expect(parseRemoteUrl("")).toBeUndefined();
    expect(parseRemoteUrl("   ")).toBeUndefined();
    expect(parseRemoteUrl("not a url")).toBeUndefined();
  });
});

describe("subjectFromRemoteUrl / localSubject", () => {
  it("builds repo: subjects from remotes", () => {
    expect(subjectFromRemoteUrl("git@github.com:smaramwbc/statewave.git")).toBe(
      "repo:smaramwbc/statewave",
    );
    expect(subjectFromRemoteUrl("https://dev.azure.com/org/project/_git/repo")).toBe(
      "repo:org/project/repo",
    );
  });
  it("returns undefined when no remote could be parsed", () => {
    expect(subjectFromRemoteUrl("garbage")).toBeUndefined();
  });
  it("local subject uses the root basename (not cwd)", () => {
    expect(localSubject("/Users/x/Projects/my-repo")).toBe("repo:my-repo");
  });
});

describe("discoverRepos", () => {
  // A virtual filesystem tree for injected listDirs/isRepo/identify.
  function fakeFs(tree: Record<string, string[]>, repoDirs: Set<string>) {
    return {
      listDirs: (dir: string) => tree[dir] ?? [],
      isRepo: (dir: string) => repoDirs.has(dir),
      identify: (dir: string): RepoIdentity => ({
        root: dir,
        subject: `repo:${dir.split("/").pop()}`,
        fromRemote: false,
      }),
    };
  }

  it("finds repos breadth-first and does not descend into a repo", () => {
    const tree: Record<string, string[]> = {
      "/p": ["a", "b", "node_modules"],
      "/p/a": ["nested"], // a is a repo — 'nested' must NOT be scanned
      "/p/a/nested": [],
      "/p/b": ["c"],
      "/p/b/c": [],
    };
    const repos = new Set(["/p/a", "/p/b/c"]);
    const { repos: found, truncated } = discoverRepos("/p", { ...fakeFs(tree, repos) });
    expect(found.map((r) => r.root).sort()).toEqual(["/p/a", "/p/b/c"]);
    expect(truncated).toBe(false);
  });

  it("excludes node_modules and hidden dirs", () => {
    const tree: Record<string, string[]> = {
      "/p": ["node_modules", ".git", "src", "real"],
      "/p/node_modules": ["pkg"],
      "/p/node_modules/pkg": [],
      "/p/src": [],
      "/p/real": [],
    };
    // a repo hidden inside node_modules must never be found
    const repos = new Set(["/p/node_modules/pkg", "/p/real"]);
    const { found } = { found: discoverRepos("/p", fakeFs(tree, repos)).repos };
    expect(found.map((r) => r.root)).toEqual(["/p/real"]);
  });

  it("respects maxDepth", () => {
    const tree: Record<string, string[]> = {
      "/p": ["l1"],
      "/p/l1": ["l2"],
      "/p/l1/l2": ["l3"],
      "/p/l1/l2/l3": [],
    };
    const repos = new Set(["/p/l1/l2/l3"]);
    expect(discoverRepos("/p", { ...fakeFs(tree, repos), maxDepth: 2 }).repos).toHaveLength(0);
    expect(discoverRepos("/p", { ...fakeFs(tree, repos), maxDepth: 3 }).repos).toHaveLength(1);
  });

  it("truncates at maxResults", () => {
    const tree: Record<string, string[]> = { "/p": ["a", "b", "c"] , "/p/a": [], "/p/b": [], "/p/c": [] };
    const repos = new Set(["/p/a", "/p/b", "/p/c"]);
    const r = discoverRepos("/p", { ...fakeFs(tree, repos), maxResults: 2 });
    expect(r.repos).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
});
