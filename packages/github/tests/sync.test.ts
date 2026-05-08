import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createGithubConnector } from "../src/index.js";

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
            "x-ratelimit-remaining": h.opts?.rateLimitRemaining ?? "100",
          },
        });
      }
    }
    return new Response("not handled", { status: 404 });
  }) as typeof fetch;
}

const ISSUE = {
  number: 1,
  title: "first issue",
  body: "hello",
  state: "open" as const,
  user: { login: "ada" },
  labels: [],
  milestone: null,
  html_url: "https://github.com/acme/widgets/issues/1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
};

const PR = {
  number: 7,
  title: "feat: thing",
  body: "do stuff",
  state: "closed" as const,
  user: { login: "linus" },
  labels: [],
  milestone: null,
  html_url: "https://github.com/acme/widgets/pull/7",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-03T00:00:00Z",
  closed_at: "2026-02-03T00:00:00Z",
  merged_at: "2026-02-03T00:00:00Z",
  pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/7" },
};

describe("github connector dry-run sync", () => {
  it("does not ingest in dry-run, returns mapped episodes", async () => {
    const connector = createGithubConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [ISSUE] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues"] });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("github.issue.opened");
    expect(result.summary.total).toBe(1);
    expect(result.summary.kinds["github.issue.opened"]).toBe(1);
    expect(result.summary.details?.events_issues).toBe(1);
  });

  it("classifies issue/comments and PR-conversation comments separately", async () => {
    const issueComment = {
      id: 1001,
      body: "+1 from me",
      user: { login: "ada" },
      html_url: "https://github.com/acme/widgets/issues/1#issuecomment-1001",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      issue_url: "https://api.github.com/repos/acme/widgets/issues/1",
    };
    const prComment = {
      id: 1002,
      body: "thanks for the patch",
      user: { login: "linus" },
      html_url: "https://github.com/acme/widgets/pull/7#issuecomment-1002",
      created_at: "2026-02-04T00:00:00Z",
      updated_at: "2026-02-04T00:00:00Z",
      issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
    };

    const connector = createGithubConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [] },
        "/repos/acme/widgets/issues/comments": { body: [issueComment, prComment] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["github.issue.comment", "github.pr.comment"]);
    expect(result.summary.details?.events_issue_comments).toBe(1);
    expect(result.summary.details?.events_pr_comments).toBe(1);
  });

  it("respects --max-items by reporting skipped count", async () => {
    const issues = [1, 2, 3, 4, 5].map((n) => ({ ...ISSUE, number: n, html_url: `https://github.com/acme/widgets/issues/${n}` }));
    const connector = createGithubConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: issues },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["issues"], maxItems: 2 });
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toBe(3);
    expect(result.summary.details?.events_fetched).toBe(5);
    expect(result.summary.details?.events_mapped).toBe(2);
  });

  it("--exclude wins over --include", async () => {
    const connector = createGithubConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [ISSUE, PR] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls/7/reviews": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({
      dryRun: true,
      include: ["issues", "prs"],
      exclude: ["prs"],
    });
    expect(result.episodes.map((e) => e.kind)).toEqual(["github.issue.opened"]);
  });

  it("surfaces a clear ConnectorError when GitHub returns 404", async () => {
    const connector = createGithubConnector({
      repo: "acme/missing",
      fetchImpl: fakeFetch({
        "/repos/acme/missing/issues?": { body: { message: "Not Found" }, opts: { status: 404 } },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["issues"] })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "not_found",
      connector: "github",
    });
  });

  it("surfaces a rate-limit error when x-ratelimit-remaining is 0", async () => {
    const connector = createGithubConnector({
      repo: "acme/widgets",
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": {
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
