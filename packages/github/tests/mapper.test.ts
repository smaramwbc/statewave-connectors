import { describe, it, expect } from "vitest";
import { defaultSubject, mapGithubEvent } from "../src/index.js";
import type {
  GithubComment,
  GithubIssue,
  GithubPullRequest,
  GithubRelease,
  GithubReview,
} from "../src/index.js";

const repo = { owner: "acme", name: "widgets" };

describe("github mapper", () => {
  it("uses repo:owner/name as the default subject", () => {
    expect(defaultSubject(repo)).toBe("repo:acme/widgets");
  });

  it("maps an opened issue to github.issue.opened", () => {
    const issue: GithubIssue = {
      type: "issue",
      number: 42,
      title: "CI is flaky",
      body: "happens on macos runners",
      state: "open",
      user: { login: "ada" },
      labels: [{ name: "bug" }, { name: "ci" }],
      milestone: { title: "v1" },
      html_url: "https://github.com/acme/widgets/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const ep = mapGithubEvent(issue, { repo });
    expect(ep.subject).toBe("repo:acme/widgets");
    expect(ep.kind).toBe("github.issue.opened");
    expect(ep.text).toContain("ada opened issue #42");
    expect(ep.metadata?.author).toBe("ada");
    expect(ep.metadata?.labels).toEqual(["bug", "ci"]);
    expect(ep.source.url).toBe(issue.html_url);
  });

  it("maps a closed issue to github.issue.closed using closed_at", () => {
    const issue: GithubIssue = {
      type: "issue",
      number: 5,
      title: "x",
      body: null,
      state: "closed",
      user: { login: "ada" },
      labels: [],
      milestone: null,
      html_url: "https://github.com/acme/widgets/issues/5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-02T00:00:00Z",
    };
    const ep = mapGithubEvent(issue, { repo });
    expect(ep.kind).toBe("github.issue.closed");
    expect(ep.occurred_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("maps a merged PR to github.pr.merged", () => {
    const pr: GithubPullRequest = {
      type: "pull_request",
      number: 100,
      title: "Add MCP server",
      body: "implements the skeleton",
      state: "closed",
      merged: true,
      user: { login: "linus" },
      labels: [],
      milestone: null,
      html_url: "https://github.com/acme/widgets/pull/100",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
      closed_at: "2026-01-03T00:00:00Z",
      merged_at: "2026-01-03T00:00:00Z",
      base: { ref: "main" },
      head: { ref: "feat/mcp" },
    };
    const ep = mapGithubEvent(pr, { repo });
    expect(ep.kind).toBe("github.pr.merged");
    expect(ep.metadata?.merged).toBe(true);
    expect(ep.metadata?.related_subjects).toContain("pr:100");
    expect(ep.metadata?.related_subjects).toContain("author:linus");
  });

  it("maps an issue comment vs a PR comment to distinct kinds", () => {
    const base: GithubComment = {
      type: "comment",
      parent: "issue",
      parent_number: 3,
      id: 999,
      body: "+1",
      user: { login: "ada" },
      html_url: "https://github.com/acme/widgets/issues/3#issuecomment-999",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    expect(mapGithubEvent(base, { repo }).kind).toBe("github.issue.comment");
    expect(mapGithubEvent({ ...base, parent: "pull_request" }, { repo }).kind).toBe(
      "github.pr.comment",
    );
  });

  it("maps a review and a release", () => {
    const review: GithubReview = {
      type: "review",
      pr_number: 7,
      id: 1,
      user: { login: "ada" },
      state: "APPROVED",
      body: "lgtm",
      html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
      submitted_at: "2026-03-01T00:00:00Z",
    };
    const re = mapGithubEvent(review, { repo });
    expect(re.kind).toBe("github.pr.review");
    expect(re.metadata?.state).toBe("APPROVED");

    const release: GithubRelease = {
      type: "release",
      id: 5,
      tag_name: "v0.1.0",
      name: "First public release",
      body: "see CHANGELOG",
      author: { login: "linus" },
      html_url: "https://github.com/acme/widgets/releases/tag/v0.1.0",
      published_at: "2026-04-01T00:00:00Z",
    };
    const rel = mapGithubEvent(release, { repo });
    expect(rel.kind).toBe("github.release.published");
    expect(rel.text).toContain("v0.1.0");
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const issue: GithubIssue = {
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
    const a = mapGithubEvent(issue, { repo });
    const b = mapGithubEvent(issue, { repo });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
