import { describe, it, expect } from "vitest";
import {
  detectForgeFromHost,
  resolveForgeKind,
  resolveForgeBaseUrl,
  parseAzureRemote,
  forgeDescriptor,
} from "../src/index.js";

describe("detectForgeFromHost", () => {
  it("maps the well-known public hosts", () => {
    expect(detectForgeFromHost("github.com")).toBe("github");
    expect(detectForgeFromHost("gitlab.com")).toBe("gitlab");
    expect(detectForgeFromHost("bitbucket.org")).toBe("bitbucket");
    expect(detectForgeFromHost("dev.azure.com")).toBe("azure-devops");
    expect(detectForgeFromHost("ssh.dev.azure.com")).toBe("azure-devops");
    expect(detectForgeFromHost("codeberg.org")).toBe("gitea");
  });

  it("detects self-managed hosts via name hints", () => {
    expect(detectForgeFromHost("gitlab.example.com")).toBe("gitlab");
    expect(detectForgeFromHost("git.example.gitea.io")).toBe("gitea");
    expect(detectForgeFromHost("acme.visualstudio.com")).toBe("azure-devops");
  });

  it("returns null for unknown / empty hosts", () => {
    expect(detectForgeFromHost("git.example.com")).toBeNull();
    expect(detectForgeFromHost(null)).toBeNull();
    expect(detectForgeFromHost("")).toBeNull();
  });
});

describe("resolveForgeKind", () => {
  it("auto delegates to host detection", () => {
    expect(resolveForgeKind("auto", "gitlab.com")).toBe("gitlab");
    expect(resolveForgeKind("auto", null)).toBeNull();
  });

  it("github-enterprise resolves to the github connector", () => {
    expect(resolveForgeKind("github-enterprise", "ghe.example.com")).toBe("github");
  });

  it("explicit kinds win over the host", () => {
    expect(resolveForgeKind("gitea", "github.com")).toBe("gitea");
  });
});

describe("resolveForgeBaseUrl", () => {
  it("explicit baseUrl wins verbatim", () => {
    expect(
      resolveForgeBaseUrl({ forge: "gitlab", kind: "gitlab", host: "h", explicitBaseUrl: "https://x/api" }),
    ).toBe("https://x/api");
  });

  it("GHES derives /api/v3 from the host", () => {
    expect(
      resolveForgeBaseUrl({ forge: "github", kind: "github-enterprise", host: "ghe.example.com" }),
    ).toBe("https://ghe.example.com/api/v3");
  });

  it("self-managed gitlab/gitea take the bare origin", () => {
    expect(resolveForgeBaseUrl({ forge: "gitlab", kind: "gitlab", host: "gitlab.example.com" })).toBe(
      "https://gitlab.example.com",
    );
    expect(resolveForgeBaseUrl({ forge: "gitea", kind: "gitea", host: "https://git.example.com/" })).toBe(
      "https://git.example.com",
    );
  });

  it("public hosts use the connector default (undefined)", () => {
    expect(resolveForgeBaseUrl({ forge: "github", kind: "auto", host: "github.com" })).toBeUndefined();
    expect(resolveForgeBaseUrl({ forge: "bitbucket", kind: "auto", host: "bitbucket.org" })).toBeUndefined();
    expect(resolveForgeBaseUrl({ forge: "gitlab", kind: "auto", host: null })).toBeUndefined();
  });
});

describe("parseAzureRemote", () => {
  it("parses the https dev.azure.com shape", () => {
    expect(parseAzureRemote("https://dev.azure.com/myorg/myproject/_git/myrepo")).toEqual({
      organization: "myorg",
      project: "myproject",
      repository: "myrepo",
    });
  });

  it("parses the org@dev.azure.com shape and strips .git", () => {
    expect(parseAzureRemote("https://myorg@dev.azure.com/myorg/My%20Project/_git/myrepo.git")).toEqual({
      organization: "myorg",
      project: "My Project",
      repository: "myrepo",
    });
  });

  it("parses the legacy visualstudio.com shape", () => {
    expect(parseAzureRemote("https://myorg.visualstudio.com/myproject/_git/myrepo")).toEqual({
      organization: "myorg",
      project: "myproject",
      repository: "myrepo",
    });
  });

  it("parses the scp-like ssh shape", () => {
    expect(parseAzureRemote("git@ssh.dev.azure.com:v3/myorg/myproject/myrepo")).toEqual({
      organization: "myorg",
      project: "myproject",
      repository: "myrepo",
    });
  });

  it("returns null for non-azure / malformed URLs", () => {
    expect(parseAzureRemote("https://github.com/acme/widgets")).toBeNull();
    expect(parseAzureRemote(null)).toBeNull();
  });
});

describe("forgeDescriptor", () => {
  it("exposes baseUrlRequired for self-hosted-only forges", () => {
    expect(forgeDescriptor("gitea").baseUrlRequired).toBe(true);
    expect(forgeDescriptor("github").baseUrlRequired).toBe(false);
    expect(forgeDescriptor("azure-devops").authProviderId).toBe("microsoft");
  });
});
