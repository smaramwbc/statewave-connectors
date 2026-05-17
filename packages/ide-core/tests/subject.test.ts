import { describe, it, expect } from "vitest";
import {
  parseGitRemote,
  resolveSubject,
  workspaceSlug,
  sanitizeSubjectId,
} from "../src/index.js";

describe("parseGitRemote", () => {
  it("parses https URLs with and without .git", () => {
    expect(parseGitRemote("https://github.com/smaramwbc/statewave-connectors.git")).toEqual({
      host: "github.com",
      owner: "smaramwbc",
      repo: "statewave-connectors",
    });
    expect(parseGitRemote("https://github.com/acme/widgets")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses scp-like git@ remotes", () => {
    expect(parseGitRemote("git@github.com:acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses ssh:// and git:// remotes", () => {
    expect(parseGitRemote("ssh://git@github.com/acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitRemote("git://github.com/acme/widgets.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("keeps nested GitLab groups in the owner", () => {
    expect(parseGitRemote("https://gitlab.com/group/subgroup/app.git")).toEqual({
      host: "gitlab.com",
      owner: "group/subgroup",
      repo: "app",
    });
  });

  it("strips ports and is host-case-insensitive", () => {
    expect(parseGitRemote("https://Git.Example.com:8443/o/r.git")).toEqual({
      host: "git.example.com",
      owner: "o",
      repo: "r",
    });
  });

  it("returns null for unparseable / empty input", () => {
    expect(parseGitRemote(null)).toBeNull();
    expect(parseGitRemote("")).toBeNull();
    expect(parseGitRemote("not-a-url")).toBeNull();
    expect(parseGitRemote("https://github.com/onlyowner")).toBeNull();
  });
});

describe("workspaceSlug", () => {
  it("lowercases and collapses whitespace", () => {
    expect(workspaceSlug("My Project")).toBe("my-project");
    expect(workspaceSlug("  ")).toBe("workspace");
  });
});

describe("sanitizeSubjectId", () => {
  it("maps '/' to '.' so the server (no '/') accepts it", () => {
    expect(sanitizeSubjectId("repo:acme/widgets")).toBe("repo:acme.widgets");
    expect(sanitizeSubjectId("repo:group/sub/app")).toBe("repo:group.sub.app");
  });
  it("keeps the server-allowed set (alnum _ . - :) and collapses the rest", () => {
    expect(sanitizeSubjectId("repo:a_b.c-d:e")).toBe("repo:a_b.c-d:e");
    expect(sanitizeSubjectId("team:a b@c")).toBe("team:a-b-c");
  });
});

describe("resolveSubject", () => {
  const folderName = "My App";

  it("auto → repo when a remote parses (sanitized for the server)", () => {
    expect(
      resolveSubject({
        config: { subjectStrategy: "auto" },
        remoteUrl: "git@github.com:acme/widgets.git",
        folderName,
      }),
    ).toBe("repo:acme.widgets");
  });

  it("auto → workspace when no remote", () => {
    expect(
      resolveSubject({
        config: { subjectStrategy: "auto" },
        remoteUrl: null,
        folderName,
      }),
    ).toBe("workspace:my-app");
  });

  it("repo strategy returns null when there is no remote (actionable)", () => {
    expect(
      resolveSubject({
        config: { subjectStrategy: "repo" },
        remoteUrl: null,
        folderName,
      }),
    ).toBeNull();
  });

  it("workspace strategy ignores the remote", () => {
    expect(
      resolveSubject({
        config: { subjectStrategy: "workspace" },
        remoteUrl: "git@github.com:acme/widgets.git",
        folderName,
      }),
    ).toBe("workspace:my-app");
  });

  it("custom strategy uses the configured subject verbatim, or null when blank", () => {
    expect(
      resolveSubject({
        config: { subjectStrategy: "custom", customSubject: "team:platform" },
        folderName,
      }),
    ).toBe("team:platform");
    expect(
      resolveSubject({
        config: { subjectStrategy: "custom", customSubject: "  " },
        folderName,
      }),
    ).toBeNull();
  });
});
