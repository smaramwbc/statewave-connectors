import { describe, it, expect } from "vitest";
import { defaultSubject, mapGiteaEvent } from "../src/index.js";
import type {
  GiteaComment,
  GiteaIssue,
  GiteaPullRequest,
  GiteaRelease,
  GiteaReview,
} from "../src/index.js";

const repo = { owner: "acme", name: "widgets" };

describe("gitea mapper", () => {
  it("uses repo:owner/name as the default subject", () => {
    expect(defaultSubject(repo)).toBe("repo:acme/widgets");
  });

  it("maps an opened issue to gitea.issue.opened", () => {
    const issue: GiteaIssue = {
      type: "issue",
      number: 42,
      title: "CI is flaky",
      body: "happens on macos runners",
      state: "open",
      user: { login: "ada" },
      labels: [{ name: "bug" }, { name: "ci" }],
      milestone: { title: "v1" },
      html_url: "https://gitea.example.com/acme/widgets/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const ep = mapGiteaEvent(issue, { repo });
    expect(ep.subject).toBe("repo:acme/widgets");
    expect(ep.kind).toBe("gitea.issue.opened");
    expect(ep.text).toContain("ada opened issue #42");
    expect(ep.metadata?.author).toBe("ada");
    expect(ep.metadata?.labels).toEqual(["bug", "ci"]);
    expect(ep.source.url).toBe(issue.html_url);
  });

  it("maps a closed issue to gitea.issue.closed using closed_at", () => {
    const issue: GiteaIssue = {
      type: "issue",
      number: 5,
      title: "x",
      body: null,
      state: "closed",
      user: { login: "ada" },
      labels: [],
      milestone: null,
      html_url: "https://gitea.example.com/acme/widgets/issues/5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-02T00:00:00Z",
    };
    const ep = mapGiteaEvent(issue, { repo });
    expect(ep.kind).toBe("gitea.issue.closed");
    expect(ep.occurred_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("maps a merged PR to gitea.pr.merged", () => {
    const pr: GiteaPullRequest = {
      type: "pull_request",
      number: 100,
      title: "Add MCP server",
      body: "implements the skeleton",
      state: "closed",
      merged: true,
      user: { login: "linus" },
      labels: [],
      milestone: null,
      html_url: "https://gitea.example.com/acme/widgets/pulls/100",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
      closed_at: "2026-01-03T00:00:00Z",
      merged_at: "2026-01-03T00:00:00Z",
      base: { ref: "main" },
      head: { ref: "feat/mcp" },
    };
    const ep = mapGiteaEvent(pr, { repo });
    expect(ep.kind).toBe("gitea.pr.merged");
    expect(ep.metadata?.merged).toBe(true);
    expect(ep.metadata?.related_subjects).toContain("pr:100");
    expect(ep.metadata?.related_subjects).toContain("author:linus");
  });

  it("maps an issue comment vs a PR comment to distinct kinds", () => {
    const base: GiteaComment = {
      type: "comment",
      parent: "issue",
      parent_number: 3,
      id: 999,
      body: "+1",
      user: { login: "ada" },
      html_url: "https://gitea.example.com/acme/widgets/issues/3#issuecomment-999",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    expect(mapGiteaEvent(base, { repo }).kind).toBe("gitea.issue.comment");
    expect(mapGiteaEvent({ ...base, parent: "pull_request" }, { repo }).kind).toBe(
      "gitea.pr.comment",
    );
  });

  it("maps a review and a release", () => {
    const review: GiteaReview = {
      type: "review",
      pr_number: 7,
      id: 1,
      user: { login: "ada" },
      state: "APPROVED",
      body: "lgtm",
      html_url: "https://gitea.example.com/acme/widgets/pulls/7#pullrequestreview-1",
      submitted_at: "2026-03-01T00:00:00Z",
    };
    const re = mapGiteaEvent(review, { repo });
    expect(re.kind).toBe("gitea.pr.review");
    expect(re.metadata?.state).toBe("APPROVED");

    const release: GiteaRelease = {
      type: "release",
      id: 5,
      tag_name: "v0.1.0",
      name: "First public release",
      body: "see CHANGELOG",
      author: { login: "linus" },
      html_url: "https://gitea.example.com/acme/widgets/releases/tag/v0.1.0",
      published_at: "2026-04-01T00:00:00Z",
    };
    const rel = mapGiteaEvent(release, { repo });
    expect(rel.kind).toBe("gitea.release.published");
    expect(rel.text).toContain("v0.1.0");
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const issue: GiteaIssue = {
      type: "issue",
      number: 1,
      title: "t",
      body: "b",
      state: "open",
      user: { login: "ada" },
      labels: [],
      milestone: null,
      html_url: "https://example",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const a = mapGiteaEvent(issue, { repo });
    const b = mapGiteaEvent(issue, { repo });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
