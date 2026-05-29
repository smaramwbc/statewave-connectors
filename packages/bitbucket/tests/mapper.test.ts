import { describe, it, expect } from "vitest";
import { defaultSubject, mapBitbucketEvent } from "../src/index.js";
import type {
  BitbucketComment,
  BitbucketIssue,
  BitbucketPullRequest,
} from "../src/index.js";

const repo = { owner: "acme", name: "widgets" };

describe("bitbucket mapper", () => {
  it("uses repo:owner/name as the default subject", () => {
    expect(defaultSubject(repo)).toBe("repo:acme/widgets");
  });

  it("maps an opened issue to bitbucket.issue.opened", () => {
    const issue: BitbucketIssue = {
      type: "issue",
      id: 42,
      title: "CI is flaky",
      body: "happens on macos runners",
      state: "open",
      user: { nickname: "ada" },
      html_url: "https://bitbucket.org/acme/widgets/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const ep = mapBitbucketEvent(issue, { repo });
    expect(ep.subject).toBe("repo:acme/widgets");
    expect(ep.kind).toBe("bitbucket.issue.opened");
    expect(ep.text).toContain("ada opened issue #42");
    expect(ep.metadata?.author).toBe("ada");
    expect(ep.occurred_at).toBe("2026-01-01T00:00:00.000Z");
    expect(ep.source.url).toBe(issue.html_url);
  });

  it("maps a resolved issue to bitbucket.issue.closed using updated_at", () => {
    const issue: BitbucketIssue = {
      type: "issue",
      id: 5,
      title: "x",
      body: null,
      state: "closed",
      user: { display_name: "Ada Lovelace" },
      html_url: "https://bitbucket.org/acme/widgets/issues/5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    };
    const ep = mapBitbucketEvent(issue, { repo });
    expect(ep.kind).toBe("bitbucket.issue.closed");
    expect(ep.occurred_at).toBe("2026-01-02T00:00:00.000Z");
    // falls back to display_name when nickname is absent
    expect(ep.metadata?.author).toBe("Ada Lovelace");
  });

  it("maps a merged PR to bitbucket.pr.merged", () => {
    const pr: BitbucketPullRequest = {
      type: "pull_request",
      id: 100,
      title: "Add MCP server",
      body: "implements the skeleton",
      state: "closed",
      merged: true,
      declined: false,
      user: { nickname: "linus" },
      html_url: "https://bitbucket.org/acme/widgets/pull-requests/100",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
      source_branch: "feat/mcp",
      destination_branch: "main",
    };
    const ep = mapBitbucketEvent(pr, { repo });
    expect(ep.kind).toBe("bitbucket.pr.merged");
    expect(ep.occurred_at).toBe("2026-01-03T00:00:00.000Z");
    expect(ep.metadata?.merged).toBe(true);
    expect(ep.metadata?.related_subjects).toContain("pr:100");
    expect(ep.metadata?.related_subjects).toContain("author:linus");
  });

  it("maps a declined PR to bitbucket.pr.closed", () => {
    const pr: BitbucketPullRequest = {
      type: "pull_request",
      id: 101,
      title: "abandoned work",
      body: null,
      state: "closed",
      merged: false,
      declined: true,
      user: { nickname: "linus" },
      html_url: "https://bitbucket.org/acme/widgets/pull-requests/101",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
    };
    const ep = mapBitbucketEvent(pr, { repo });
    expect(ep.kind).toBe("bitbucket.pr.closed");
    expect(ep.occurred_at).toBe("2026-01-04T00:00:00.000Z");
  });

  it("maps an open PR to bitbucket.pr.opened using created_at", () => {
    const pr: BitbucketPullRequest = {
      type: "pull_request",
      id: 102,
      title: "wip",
      body: null,
      state: "open",
      merged: false,
      declined: false,
      user: { nickname: "ada" },
      html_url: "https://bitbucket.org/acme/widgets/pull-requests/102",
      created_at: "2026-01-05T00:00:00Z",
      updated_at: "2026-01-06T00:00:00Z",
    };
    const ep = mapBitbucketEvent(pr, { repo });
    expect(ep.kind).toBe("bitbucket.pr.opened");
    expect(ep.occurred_at).toBe("2026-01-05T00:00:00.000Z");
  });

  it("maps a PR comment to bitbucket.pr.comment", () => {
    const comment: BitbucketComment = {
      type: "comment",
      parent: "pull_request",
      parent_id: 7,
      id: 999,
      body: "thanks for the patch",
      user: { nickname: "ada" },
      html_url: "https://bitbucket.org/acme/widgets/pull-requests/7/_/diff#comment-999",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    const ep = mapBitbucketEvent(comment, { repo });
    expect(ep.kind).toBe("bitbucket.pr.comment");
    expect(ep.text).toBe("thanks for the patch");
    expect(ep.metadata?.parent_id).toBe(7);
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const issue: BitbucketIssue = {
      type: "issue",
      id: 1,
      title: "t",
      body: "b",
      state: "open",
      user: { nickname: "ada" },
      html_url: "https://example",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    const a = mapBitbucketEvent(issue, { repo });
    const b = mapBitbucketEvent(issue, { repo });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
