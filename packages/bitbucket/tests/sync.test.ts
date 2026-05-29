import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createBitbucketConnector } from "../src/index.js";

interface FakeFetchOptions {
  status?: number;
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
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not handled", { status: 404 });
  }) as typeof fetch;
}

const MERGED_PR = {
  id: 7,
  title: "feat: thing",
  description: "do stuff",
  state: "MERGED",
  author: { nickname: "linus" },
  created_on: "2026-02-01T00:00:00Z",
  updated_on: "2026-02-03T00:00:00Z",
  links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/7" } },
  source: { branch: { name: "feat/thing" } },
  destination: { branch: { name: "main" } },
};

const RESOLVED_ISSUE = {
  id: 1,
  title: "first issue",
  content: { raw: "hello" },
  state: "resolved",
  reporter: { nickname: "ada" },
  created_on: "2026-01-01T00:00:00Z",
  updated_on: "2026-01-02T00:00:00Z",
  links: { html: { href: "https://bitbucket.org/acme/widgets/issues/1" } },
};

describe("bitbucket connector dry-run sync", () => {
  it("maps a MERGED PR to bitbucket.pr.merged in dry-run without ingesting", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests?": { body: { values: [MERGED_PR] } },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["prs"] });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("bitbucket.pr.merged");
    expect(result.summary.total).toBe(1);
    expect(result.summary.kinds["bitbucket.pr.merged"]).toBe(1);
    expect(result.summary.details?.events_prs).toBe(1);
  });

  it("maps a resolved issue to bitbucket.issue.closed", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/issues?": { body: { values: [RESOLVED_ISSUE] } },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues"] });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("bitbucket.issue.closed");
    expect(result.summary.details?.events_issues).toBe(1);
  });

  it("handles a disabled issue tracker (404) gracefully and still returns PR episodes", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests?": { body: { values: [MERGED_PR] } },
        "/repositories/acme/widgets/issues?": {
          body: { type: "error", error: { message: "Repository has no issue tracker." } },
          opts: { status: 404 },
        },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues", "prs"] });
    // issues skipped (404 swallowed), PR still mapped
    expect(result.episodes.map((e) => e.kind)).toEqual(["bitbucket.pr.merged"]);
    expect(result.summary.details?.events_issues).toBe(0);
    expect(result.summary.details?.events_prs).toBe(1);
  });

  it("follows the `next` pagination link until exhausted", async () => {
    const page1 = {
      values: [{ ...MERGED_PR, id: 1 }, { ...MERGED_PR, id: 2 }],
      next: "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?page=2",
    };
    const page2 = {
      values: [{ ...MERGED_PR, id: 3 }],
    };
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "pullrequests?page=2": { body: page2 },
        "/repositories/acme/widgets/pullrequests?": { body: page1 },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["prs"] });
    expect(result.episodes).toHaveLength(3);
    expect(result.summary.details?.events_prs).toBe(3);
  });

  it("respects --max-items by reporting skipped count", async () => {
    const prs = [1, 2, 3, 4, 5].map((n) => ({ ...MERGED_PR, id: n }));
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests?": { body: { values: prs } },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs"], maxItems: 2 });
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toBe(3);
    expect(result.summary.details?.events_fetched).toBe(5);
    expect(result.summary.details?.events_mapped).toBe(2);
  });

  it("surfaces a ConnectorError auth_failed when Bitbucket returns 401", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests?": {
          body: { type: "error" },
          opts: { status: 401 },
        },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["prs"] })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "auth_failed",
      connector: "bitbucket",
    });
  });

  it("skips deleted and content-less PR comments", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests/7/comments": {
          body: {
            values: [
              {
                id: 1,
                content: { raw: "real comment" },
                user: { nickname: "ada" },
                created_on: "2026-02-04T00:00:00Z",
                updated_on: "2026-02-04T00:00:00Z",
                links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/7#c1" } },
              },
              { id: 2, content: { raw: "deleted one" }, deleted: true, created_on: "x", updated_on: "x" },
              { id: 3, content: { raw: null }, created_on: "x", updated_on: "x" },
            ],
          },
        },
        "/repositories/acme/widgets/pullrequests?": { body: { values: [MERGED_PR] } },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    const commentEpisodes = result.episodes.filter((e) => e.kind === "bitbucket.pr.comment");
    expect(commentEpisodes).toHaveLength(1);
    expect(commentEpisodes[0]?.text).toBe("real comment");
    expect(result.summary.details?.events_pr_comments).toBe(1);
  });

  it("maps an issue comment to bitbucket.issue.comment with parent_number set", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/issues/1/comments": {
          body: {
            values: [
              {
                id: 11,
                content: { raw: "an issue reply" },
                user: { nickname: "ada" },
                created_on: "2026-01-03T00:00:00Z",
                updated_on: "2026-01-03T00:00:00Z",
                links: { html: { href: "https://bitbucket.org/acme/widgets/issues/1#c11" } },
              },
              { id: 12, content: { raw: "gone" }, deleted: true, created_on: "x", updated_on: "x" },
            ],
          },
        },
        "/repositories/acme/widgets/issues?": { body: { values: [RESOLVED_ISSUE] } },
        // "comments" also pulls PR comments — stub an empty PR list.
        "/repositories/acme/widgets/pullrequests": { body: { values: [] } },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    const issueComments = result.episodes.filter((e) => e.kind === "bitbucket.issue.comment");
    expect(issueComments).toHaveLength(1);
    expect(issueComments[0]?.text).toBe("an issue reply");
    expect(issueComments[0]?.metadata?.parent_number).toBe(1);
    expect(issueComments[0]?.metadata?.parent).toBe("issue");
    expect(result.summary.details?.events_issue_comments).toBe(1);
  });

  it("swallows a per-issue comments 404 without failing the sync", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/issues/1/comments": {
          body: { type: "error", error: { message: "Not found." } },
          opts: { status: 404 },
        },
        "/repositories/acme/widgets/issues?": { body: { values: [RESOLVED_ISSUE] } },
        // "comments" also pulls PR comments — stub an empty PR list.
        "/repositories/acme/widgets/pullrequests": { body: { values: [] } },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues", "comments"] });
    // issue still mapped, comments skipped (404 swallowed)
    expect(result.episodes.map((e) => e.kind)).toEqual(["bitbucket.issue.closed"]);
    expect(result.summary.details?.events_issue_comments).toBe(0);
  });

  it("ConnectorError is thrown for 401 (instance check)", async () => {
    const connector = createBitbucketConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repositories/acme/widgets/pullrequests?": { body: {}, opts: { status: 401 } },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["prs"] })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
