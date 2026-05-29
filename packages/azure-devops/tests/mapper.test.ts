import { describe, it, expect } from "vitest";
import { defaultSubject, mapAzureEvent } from "../src/index.js";
import type {
  AzureComment,
  AzurePullRequest,
  AzureReview,
  AzureWorkItem,
} from "../src/index.js";

const repo = { organization: "acme", project: "platform", repository: "widgets" };

describe("azure devops mapper", () => {
  it("uses repo:org/project/repo as the default subject", () => {
    expect(defaultSubject(repo)).toBe("repo:acme/platform/widgets");
  });

  it("maps a completed PR to azure.pr.merged using closedDate", () => {
    const pr: AzurePullRequest = {
      type: "pull_request",
      pullRequestId: 100,
      title: "Add MCP server",
      description: "implements the skeleton",
      status: "completed",
      merged: true,
      createdBy: { displayName: "Linus T", uniqueName: "linus@acme.com" },
      creationDate: "2026-01-01T00:00:00Z",
      closedDate: "2026-01-03T00:00:00Z",
      sourceRefName: "refs/heads/feat/mcp",
      targetRefName: "refs/heads/main",
      reviewers: [],
      html_url: "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/100",
    };
    const ep = mapAzureEvent(pr, { repo });
    expect(ep.subject).toBe("repo:acme/platform/widgets");
    expect(ep.kind).toBe("azure.pr.merged");
    expect(ep.occurred_at).toBe("2026-01-03T00:00:00.000Z");
    expect(ep.metadata?.merged).toBe(true);
    expect(ep.metadata?.related_subjects).toContain("pr:100");
    expect(ep.metadata?.related_subjects).toContain("author:Linus T");
    expect(ep.text).toContain("Linus T merged PR !100");
  });

  it("maps an abandoned PR to azure.pr.closed", () => {
    const pr: AzurePullRequest = {
      type: "pull_request",
      pullRequestId: 7,
      title: "scrapped idea",
      description: null,
      status: "abandoned",
      merged: false,
      createdBy: { displayName: "Ada" },
      creationDate: "2026-02-01T00:00:00Z",
      closedDate: "2026-02-02T00:00:00Z",
      reviewers: [],
      html_url: "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/7",
    };
    const ep = mapAzureEvent(pr, { repo });
    expect(ep.kind).toBe("azure.pr.closed");
    expect(ep.occurred_at).toBe("2026-02-02T00:00:00.000Z");
  });

  it("maps an active PR to azure.pr.opened using creationDate", () => {
    const pr: AzurePullRequest = {
      type: "pull_request",
      pullRequestId: 8,
      title: "wip",
      description: null,
      status: "active",
      merged: false,
      createdBy: { displayName: "Ada" },
      creationDate: "2026-03-01T00:00:00Z",
      closedDate: null,
      reviewers: [],
      html_url: "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/8",
    };
    const ep = mapAzureEvent(pr, { repo });
    expect(ep.kind).toBe("azure.pr.opened");
    expect(ep.occurred_at).toBe("2026-03-01T00:00:00.000Z");
  });

  it("maps a PR comment to azure.pr.comment", () => {
    const comment: AzureComment = {
      type: "comment",
      pr_id: 100,
      thread_id: 55,
      id: 999,
      content: "looks good to me",
      author: { displayName: "Ada" },
      publishedDate: "2026-01-02T00:00:00Z",
      html_url: "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/100",
    };
    const ep = mapAzureEvent(comment, { repo });
    expect(ep.kind).toBe("azure.pr.comment");
    expect(ep.text).toBe("looks good to me");
    expect(ep.metadata?.thread_id).toBe(55);
  });

  it("maps a review (vote 10 → approved)", () => {
    const review: AzureReview = {
      type: "review",
      pr_id: 7,
      reviewer_index: 0,
      reviewer: { displayName: "Ada" },
      vote: 10,
      state: "approved",
      occurred_at: "2026-03-01T00:00:00Z",
      html_url: "https://dev.azure.com/acme/platform/_git/widgets/pullrequest/7",
    };
    const ep = mapAzureEvent(review, { repo });
    expect(ep.kind).toBe("azure.pr.review");
    expect(ep.metadata?.state).toBe("approved");
    expect(ep.metadata?.vote).toBe(10);
    expect(ep.text).toContain("(approved)");
  });

  it("maps a created work item and a closed work item to distinct kinds", () => {
    const open: AzureWorkItem = {
      type: "work_item",
      id: 42,
      title: "CI is flaky",
      state: "Active",
      workItemType: "Bug",
      createdBy: { displayName: "Ada" },
      createdDate: "2026-01-01T00:00:00Z",
      changedDate: "2026-01-01T00:00:00Z",
      closed: false,
      html_url: "https://dev.azure.com/acme/platform/_workitems/edit/42",
    };
    expect(mapAzureEvent(open, { repo }).kind).toBe("azure.workitem.created");
    expect(mapAzureEvent({ ...open, closed: true, state: "Closed" }, { repo }).kind).toBe(
      "azure.workitem.closed",
    );
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const pr: AzurePullRequest = {
      type: "pull_request",
      pullRequestId: 1,
      title: "t",
      description: "b",
      status: "active",
      merged: false,
      createdBy: { displayName: "Ada" },
      creationDate: "2026-01-01T00:00:00Z",
      closedDate: null,
      reviewers: [],
      html_url: "https://example",
    };
    const a = mapAzureEvent(pr, { repo });
    const b = mapAzureEvent(pr, { repo });
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });
});
