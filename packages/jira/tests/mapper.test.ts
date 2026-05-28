import { describe, it, expect } from "vitest";
import { defaultSubject, flattenAdf, mapJiraEvent, userDisplay } from "../src/index.js";
import type { JiraComment, JiraIssue } from "../src/index.js";

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    type: "issue",
    key: "ENG-1",
    projectKey: "ENG",
    summary: "Login broken",
    description: "users cannot log in",
    statusName: "To Do",
    statusCategory: "new",
    issueType: "Bug",
    priority: "High",
    labels: ["auth"],
    assignee: "Ada L",
    reporter: "Bob R",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-02T00:00:00Z",
    resolutionDate: null,
    url: "https://acme.atlassian.net/browse/ENG-1",
    ...overrides,
  };
}

describe("jira mapper", () => {
  it("uses project:<KEY> as the default subject", () => {
    expect(defaultSubject("ENG")).toBe("project:ENG");
  });

  it("maps an open issue to jira.issue.created using created date", () => {
    const ep = mapJiraEvent(issue());
    expect(ep.subject).toBe("project:ENG");
    expect(ep.kind).toBe("jira.issue.created");
    expect(ep.text).toContain("Bob R created issue ENG-1: Login broken");
    expect(ep.text).toContain("users cannot log in");
    expect(ep.occurred_at).toBe("2026-01-01T00:00:00.000Z");
    expect(ep.metadata?.status).toBe("To Do");
    expect(ep.metadata?.labels).toEqual(["auth"]);
    expect(ep.metadata?.reporter).toBe("Bob R");
    expect(ep.source.type).toBe("jira.issue");
    expect(ep.source.id).toBe("ENG-1");
    expect(ep.source.url).toBe("https://acme.atlassian.net/browse/ENG-1");
    expect(ep.metadata?.related_subjects).toContain("issue:ENG-1");
    expect(ep.metadata?.related_subjects).toContain("assignee:Ada L");
  });

  it("maps a done issue to jira.issue.resolved using the resolution date", () => {
    const ep = mapJiraEvent(
      issue({ statusName: "Done", statusCategory: "done", resolutionDate: "2026-01-05T00:00:00Z" }),
    );
    expect(ep.kind).toBe("jira.issue.resolved");
    expect(ep.occurred_at).toBe("2026-01-05T00:00:00.000Z");
    expect(ep.text).toContain("Ada L resolved issue ENG-1");
  });

  it("honors a subject override", () => {
    const ep = mapJiraEvent(issue(), { subject: "customer:acme" });
    expect(ep.subject).toBe("customer:acme");
  });

  it("maps a comment to jira.comment.created", () => {
    const comment: JiraComment = {
      type: "comment",
      id: "10001",
      issueKey: "ENG-1",
      projectKey: "ENG",
      author: "Ada L",
      body: "looking into it",
      created: "2026-02-01T00:00:00Z",
      updated: "2026-02-01T00:00:00Z",
      url: "https://acme.atlassian.net/browse/ENG-1?focusedCommentId=10001",
    };
    const ep = mapJiraEvent(comment);
    expect(ep.kind).toBe("jira.comment.created");
    expect(ep.subject).toBe("project:ENG");
    expect(ep.text).toContain("Ada L commented on ENG-1");
    expect(ep.text).toContain("looking into it");
    expect(ep.source.id).toBe("ENG-1/10001");
  });

  it("idempotency keys are stable across re-maps of the same event", () => {
    const a = mapJiraEvent(issue());
    const b = mapJiraEvent(issue());
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it("flattenAdf turns an ADF document into plain text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    };
    expect(flattenAdf(doc)).toBe("Hello\nWorld");
    expect(flattenAdf(null)).toBe("");
  });

  it("userDisplay prefers displayName, falls back to accountId, never email", () => {
    expect(userDisplay({ displayName: "Ada L", accountId: "acc1" })).toBe("Ada L");
    expect(userDisplay({ accountId: "acc1" })).toBe("acc1");
    expect(userDisplay(null)).toBeNull();
  });
});
