import { describe, it, expect } from "vitest";
import { defaultSubject, mapGitlabEvent } from "../src/index.js";
import type {
  GitlabApproval,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNote,
  GitlabRelease,
} from "../src/index.js";

const repo = { owner: "acme", name: "widgets" };

describe("gitlab mapper", () => {
  it("uses repo:owner/name as the default subject", () => {
    expect(defaultSubject(repo)).toBe("repo:acme/widgets");
  });

  it("uses the full nested-group path in the subject", () => {
    expect(defaultSubject({ owner: "group/sub", name: "project" })).toBe(
      "repo:group/sub/project",
    );
  });

  it("maps an opened issue to gitlab.issue.opened", () => {
    const issue: GitlabIssue = {
      type: "issue",
      iid: 42,
      title: "CI is flaky",
      description: "happens on macos runners",
      state: "opened",
      author: { username: "ada" },
      labels: ["bug", "ci"],
      milestone: { title: "v1" },
      web_url: "https://gitlab.com/acme/widgets/-/issues/42",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const ep = mapGitlabEvent(issue, { repo });
    expect(ep.subject).toBe("repo:acme/widgets");
    expect(ep.kind).toBe("gitlab.issue.opened");
    expect(ep.text).toContain("ada opened issue #42");
    expect(ep.metadata?.author).toBe("ada");
    expect(ep.metadata?.labels).toEqual(["bug", "ci"]);
    expect(ep.source.url).toBe(issue.web_url);
  });

  it("maps a closed issue to gitlab.issue.closed using closed_at", () => {
    const issue: GitlabIssue = {
      type: "issue",
      iid: 5,
      title: "x",
      description: null,
      state: "closed",
      author: { username: "ada" },
      labels: [],
      milestone: null,
      web_url: "https://gitlab.com/acme/widgets/-/issues/5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      closed_at: "2026-01-02T00:00:00Z",
    };
    const ep = mapGitlabEvent(issue, { repo });
    expect(ep.kind).toBe("gitlab.issue.closed");
    expect(ep.occurred_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("maps a merged MR to gitlab.mr.merged", () => {
    const mr: GitlabMergeRequest = {
      type: "merge_request",
      iid: 100,
      title: "Add MCP server",
      description: "implements the skeleton",
      state: "merged",
      author: { username: "linus" },
      labels: [],
      milestone: null,
      web_url: "https://gitlab.com/acme/widgets/-/merge_requests/100",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
      closed_at: null,
      merged_at: "2026-01-03T00:00:00Z",
      source_branch: "feat/mcp",
      target_branch: "main",
    };
    const ep = mapGitlabEvent(mr, { repo });
    expect(ep.kind).toBe("gitlab.mr.merged");
    expect(ep.occurred_at).toBe("2026-01-03T00:00:00.000Z");
    expect(ep.metadata?.merged).toBe(true);
    expect(ep.metadata?.related_subjects).toContain("mr:100");
    expect(ep.metadata?.related_subjects).toContain("author:linus");
  });

  it("maps an opened MR to gitlab.mr.opened", () => {
    const mr: GitlabMergeRequest = {
      type: "merge_request",
      iid: 101,
      title: "WIP",
      description: null,
      state: "opened",
      author: { username: "linus" },
      labels: [],
      milestone: null,
      web_url: "https://gitlab.com/acme/widgets/-/merge_requests/101",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      closed_at: null,
      merged_at: null,
    };
    const ep = mapGitlabEvent(mr, { repo });
    expect(ep.kind).toBe("gitlab.mr.opened");
    expect(ep.occurred_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("maps an issue note vs an MR note to distinct kinds", () => {
    const base: GitlabNote = {
      type: "note",
      parent: "issue",
      parent_iid: 3,
      parent_web_url: "https://gitlab.com/acme/widgets/-/issues/3",
      id: 999,
      body: "+1",
      author: { username: "ada" },
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    };
    const issueEp = mapGitlabEvent(base, { repo });
    expect(issueEp.kind).toBe("gitlab.issue.comment");
    expect(issueEp.source.url).toBe(
      "https://gitlab.com/acme/widgets/-/issues/3#note_999",
    );
    expect(
      mapGitlabEvent(
        {
          ...base,
          parent: "merge_request",
          parent_web_url: "https://gitlab.com/acme/widgets/-/merge_requests/3",
        },
        { repo },
      ).kind,
    ).toBe("gitlab.mr.comment");
  });

  it("maps an approval and a release", () => {
    const approval: GitlabApproval = {
      type: "approval",
      mr_iid: 7,
      mr_web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
      approver: "ada",
      occurred_at: "2026-03-01T00:00:00Z",
    };
    const ap = mapGitlabEvent(approval, { repo });
    expect(ap.kind).toBe("gitlab.mr.approval");
    expect(ap.metadata?.approver).toBe("ada");
    expect(ap.text).toContain("ada approved merge request !7");

    const release: GitlabRelease = {
      type: "release",
      tag_name: "v0.1.0",
      name: "First public release",
      description: "see CHANGELOG",
      author: { username: "linus" },
      web_url: "https://gitlab.com/acme/widgets/-/releases/v0.1.0",
      released_at: "2026-04-01T00:00:00Z",
    };
    const rel = mapGitlabEvent(release, { repo });
    expect(rel.kind).toBe("gitlab.release.published");
    expect(rel.text).toContain("v0.1.0");
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const issue: GitlabIssue = {
      type: "issue",
      iid: 1,
      title: "t",
      description: "b",
      state: "opened",
      author: { username: "ada" },
      labels: [],
      milestone: null,
      web_url: "https://example",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: null,
    };
    const a = mapGitlabEvent(issue, { repo });
    const b = mapGitlabEvent(issue, { repo });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
