import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createGitlabConnector } from "../src/index.js";

interface FakeFetchOptions {
  status?: number;
  rateLimitRemaining?: string;
}

function fakeFetch(
  handlers: Record<string, { body: unknown; opts?: FakeFetchOptions }>,
): typeof fetch {
  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, h] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        return new Response(JSON.stringify(h.body), {
          status: h.opts?.status ?? 200,
          headers: {
            "content-type": "application/json",
            "ratelimit-remaining": h.opts?.rateLimitRemaining ?? "100",
          },
        });
      }
    }
    return new Response("not handled", { status: 404 });
  }) as typeof fetch;
}

// Project id is URL-encoded "owner/name" → acme%2Fwidgets.
const PROJECT = "/projects/acme%2Fwidgets";

const ISSUE = {
  iid: 1,
  title: "first issue",
  description: "hello",
  state: "opened" as const,
  author: { username: "ada" },
  labels: [],
  milestone: null,
  web_url: "https://gitlab.com/acme/widgets/-/issues/1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
};

const MR = {
  iid: 7,
  title: "feat: thing",
  description: "do stuff",
  state: "merged" as const,
  author: { username: "linus" },
  labels: [],
  milestone: null,
  web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-03T00:00:00Z",
  closed_at: null,
  merged_at: "2026-02-03T00:00:00Z",
  source_branch: "feat/thing",
  target_branch: "main",
};

describe("gitlab connector dry-run sync", () => {
  it("does not ingest in dry-run, maps an opened issue", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/issues?`]: { body: [ISSUE] },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues"] });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("gitlab.issue.opened");
    expect(result.summary.total).toBe(1);
    expect(result.summary.kinds["gitlab.issue.opened"]).toBe(1);
    expect(result.summary.details?.events_issues).toBe(1);
  });

  it("maps a merged MR to gitlab.mr.merged", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/merge_requests?`]: { body: [MR] },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["mrs"] });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitlab.mr.merged"]);
    expect(result.summary.details?.events_mrs).toBe(1);
  });

  it("skips system notes when ingesting comments", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/issues?`]: { body: [ISSUE] },
        // "comments" also pulls MR notes — stub an empty MR list so the run
        // exercises only the issue-notes path under test.
        [`${PROJECT}/merge_requests?`]: { body: [] },
        [`${PROJECT}/issues/1/notes`]: {
          body: [
            {
              id: 11,
              body: "real comment",
              author: { username: "ada" },
              created_at: "2026-01-02T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              system: false,
            },
            {
              id: 12,
              body: "changed the milestone",
              author: { username: "ada" },
              created_at: "2026-01-02T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              system: true,
            },
          ],
        },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitlab.issue.comment"]);
    expect(result.episodes[0]?.source.url).toBe(
      "https://gitlab.com/acme/widgets/-/issues/1#note_11",
    );
    expect(result.summary.details?.events_issue_comments).toBe(1);
  });

  it("emits one approval episode per approver", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/merge_requests?`]: { body: [MR] },
        [`${PROJECT}/merge_requests/7/approvals`]: {
          body: {
            approved_by: [{ user: { username: "ada" } }, { user: { username: "grace" } }],
          },
        },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["approvals"] });
    const kinds = result.episodes.map((e) => e.kind);
    expect(kinds).toEqual(["gitlab.mr.approval", "gitlab.mr.approval"]);
    expect(result.summary.details?.events_approvals).toBe(2);
    // approvals fall back to the MR's updated_at
    expect(result.episodes[0]?.occurred_at).toBe("2026-02-03T00:00:00.000Z");
  });

  it("respects --max-items by reporting skipped count", async () => {
    const issues = [1, 2, 3, 4, 5].map((n) => ({
      ...ISSUE,
      iid: n,
      web_url: `https://gitlab.com/acme/widgets/-/issues/${n}`,
    }));
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/issues?`]: { body: issues },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["issues"], maxItems: 2 });
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toBe(3);
    expect(result.summary.details?.events_fetched).toBe(5);
    expect(result.summary.details?.events_mapped).toBe(2);
  });

  it("--exclude wins over --include", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/issues?`]: { body: [ISSUE] },
        [`${PROJECT}/merge_requests?`]: { body: [MR] },
      }),
    });
    const result = await connector.sync({
      dryRun: true,
      include: ["issues", "mrs"],
      exclude: ["mrs"],
    });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitlab.issue.opened"]);
  });

  it("surfaces a clear ConnectorError when GitLab returns 404", async () => {
    const connector = createGitlabConnector({
      repo: "acme/missing",
      fetchImpl: fakeFetch({
        "/projects/acme%2Fmissing/issues?": {
          body: { message: "404 Project Not Found" },
          opts: { status: 404 },
        },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["issues"] })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "not_found",
      connector: "gitlab",
    });
  });

  it("surfaces a rate-limit error when ratelimit-remaining is 0", async () => {
    const connector = createGitlabConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        [`${PROJECT}/issues?`]: {
          body: [],
          opts: { status: 200, rateLimitRemaining: "0" },
        },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["issues"] })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
