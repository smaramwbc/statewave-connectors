import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createAzureDevOpsConnector, parseRepoRef } from "../src/index.js";

interface FakeFetchOptions {
  status?: number;
  contentType?: string;
}

function fakeFetch(
  handlers: Record<string, { body: unknown; opts?: FakeFetchOptions }>,
): typeof fetch {
  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, h] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        const body = h.opts?.contentType === "text/html" ? "<html>sign in</html>" : JSON.stringify(h.body);
        return new Response(body, {
          status: h.opts?.status ?? 200,
          headers: {
            "content-type": h.opts?.contentType ?? "application/json",
          },
        });
      }
    }
    return new Response("not handled", { status: 404 });
  }) as typeof fetch;
}

const COMPLETED_PR = {
  pullRequestId: 100,
  title: "Add MCP server",
  description: "implements the skeleton",
  status: "completed",
  createdBy: { displayName: "Linus T", uniqueName: "linus@acme.com" },
  creationDate: "2026-01-01T00:00:00Z",
  closedDate: "2026-01-03T00:00:00Z",
  sourceRefName: "refs/heads/feat/mcp",
  targetRefName: "refs/heads/main",
  reviewers: [{ displayName: "Ada", vote: 10 }],
  repository: { webUrl: "https://dev.azure.com/acme/platform/_git/widgets" },
};

const ABANDONED_PR = {
  pullRequestId: 7,
  title: "scrapped",
  description: null,
  status: "abandoned",
  createdBy: { displayName: "Ada" },
  creationDate: "2026-02-01T00:00:00Z",
  closedDate: "2026-02-02T00:00:00Z",
  reviewers: [],
  repository: { webUrl: "https://dev.azure.com/acme/platform/_git/widgets" },
};

describe("azure devops connector dry-run sync", () => {
  it("maps a completed PR to azure.pr.merged", async () => {
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { value: [COMPLETED_PR] } },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs"] });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("azure.pr.merged");
    expect(result.summary.details?.events_prs).toBe(1);
  });

  it("maps an abandoned PR to azure.pr.closed", async () => {
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { value: [ABANDONED_PR] } },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs"] });
    expect(result.episodes.map((e) => e.kind)).toEqual(["azure.pr.closed"]);
  });

  it("derives a review (vote 10 → approved) from PR reviewers", async () => {
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { value: [COMPLETED_PR] } },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["reviews"] });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("azure.pr.review");
    expect(result.episodes[0]?.metadata?.state).toBe("approved");
    expect(result.summary.details?.events_pr_reviews).toBe(1);
  });

  it("skips system thread comments and empty comments", async () => {
    const threads = {
      value: [
        {
          id: 11,
          lastUpdatedDate: "2026-01-02T00:00:00Z",
          comments: [
            {
              id: 1,
              content: "real feedback",
              author: { displayName: "Ada" },
              publishedDate: "2026-01-02T00:00:00Z",
              commentType: "text",
            },
            {
              id: 2,
              content: "Linus voted 10",
              author: { displayName: "system" },
              publishedDate: "2026-01-02T00:01:00Z",
              commentType: "system",
            },
            {
              id: 3,
              content: "   ",
              author: { displayName: "Ada" },
              publishedDate: "2026-01-02T00:02:00Z",
              commentType: "text",
            },
          ],
        },
      ],
    };
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { value: [COMPLETED_PR] } },
        "/pullRequests/100/threads": { body: threads },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    const kinds = result.episodes.map((e) => e.kind);
    expect(kinds).toEqual(["azure.pr.comment"]);
    expect(result.episodes[0]?.text).toBe("real feedback");
    expect(result.summary.details?.events_pr_comments).toBe(1);
  });

  it("fetches work items via wiql + batch and classifies created/closed", async () => {
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/_apis/wit/wiql": { body: { workItems: [{ id: 42 }, { id: 43 }] } },
        "/_apis/wit/workitems?ids=": {
          body: {
            value: [
              {
                id: 42,
                fields: {
                  "System.Title": "CI is flaky",
                  "System.State": "Active",
                  "System.WorkItemType": "Bug",
                  "System.CreatedBy": { displayName: "Ada" },
                  "System.CreatedDate": "2026-01-01T00:00:00Z",
                  "System.ChangedDate": "2026-01-01T00:00:00Z",
                },
                _links: { html: { href: "https://dev.azure.com/acme/platform/_workitems/edit/42" } },
              },
              {
                id: 43,
                fields: {
                  "System.Title": "Ship it",
                  "System.State": "Closed",
                  "System.WorkItemType": "Task",
                  "System.CreatedBy": "Linus T",
                  "System.CreatedDate": "2026-01-02T00:00:00Z",
                  "System.ChangedDate": "2026-01-05T00:00:00Z",
                },
              },
            ],
          },
        },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["workitems"] });
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["azure.workitem.closed", "azure.workitem.created"]);
    expect(result.summary.details?.events_workitems).toBe(2);
  });

  it("respects --max-items by reporting skipped count", async () => {
    const prs = [1, 2, 3, 4, 5].map((n) => ({
      ...COMPLETED_PR,
      pullRequestId: n,
    }));
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      token: "pat",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { value: prs } },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs"], maxItems: 2 });
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toBe(3);
    expect(result.summary.details?.events_fetched).toBe(5);
    expect(result.summary.details?.events_mapped).toBe(2);
  });

  it("parseRepoRef rejects a 2-part spec", () => {
    expect(() => parseRepoRef("acme/widgets")).toThrowError(ConnectorError);
    try {
      parseRepoRef("acme/widgets");
    } catch (err) {
      expect(err).toMatchObject({
        name: "ConnectorError",
        code: "config_invalid",
        connector: "azure-devops",
      });
    }
  });

  it("surfaces auth_failed when Azure returns 401", async () => {
    const connector = createAzureDevOpsConnector({
      repo: "acme/platform/widgets",
      fetchImpl: fakeFetch({
        "/widgets/pullrequests?": { body: { message: "unauthorized" }, opts: { status: 401 } },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["prs"] })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "auth_failed",
      connector: "azure-devops",
    });
  });
});
