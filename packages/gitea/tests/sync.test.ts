import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createGiteaConnector } from "../src/index.js";

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

const HOST = "https://gitea.example.com";

const ISSUE = {
  number: 1,
  title: "first issue",
  body: "hello",
  state: "open" as const,
  user: { login: "ada" },
  labels: [],
  milestone: null,
  html_url: "https://gitea.example.com/acme/widgets/issues/1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
};

const PR = {
  number: 7,
  title: "feat: thing",
  body: "do stuff",
  state: "closed" as const,
  merged: true,
  user: { login: "linus" },
  labels: [],
  milestone: null,
  html_url: "https://gitea.example.com/acme/widgets/pulls/7",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-02-03T00:00:00Z",
  closed_at: "2026-02-03T00:00:00Z",
  merged_at: "2026-02-03T00:00:00Z",
};

describe("gitea connector construction", () => {
  it("throws config_invalid when baseUrl is missing", () => {
    expect(() =>
      createGiteaConnector({
        repo: "acme/widgets",
        baseUrl: "",
        fetchImpl: fakeFetch({}),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "ConnectorError",
        code: "config_invalid",
        connector: "gitea",
      }),
    );
  });
});

describe("gitea connector dry-run sync", () => {
  it("does not ingest in dry-run, returns mapped episodes", async () => {
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [ISSUE] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls?": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["issues"] });
    expect(result.dryRun).toBe(true);
    expect(result.ingested).toBe(0);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("gitea.issue.opened");
    expect(result.summary.total).toBe(1);
    expect(result.summary.kinds["gitea.issue.opened"]).toBe(1);
    expect(result.summary.details?.events_issues).toBe(1);
  });

  it("maps a merged PR to gitea.pr.merged", async () => {
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls/7/reviews": { body: [] },
        "/repos/acme/widgets/pulls?": { body: [PR] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs"] });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitea.pr.merged"]);
    expect(result.summary.details?.events_prs).toBe(1);
  });

  it("classifies issue/comments and PR-conversation comments separately", async () => {
    const issueComment = {
      id: 1001,
      body: "+1 from me",
      user: { login: "ada" },
      html_url: "https://gitea.example.com/acme/widgets/issues/1#issuecomment-1001",
      created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      issue_url: "https://gitea.example.com/api/v1/repos/acme/widgets/issues/1",
    };
    // Real Forgejo/Gitea shape (verified live on Codeberg): a PR comment has an
    // EMPTY issue_url and the parent number only in pull_request_url.
    const prComment = {
      id: 1002,
      body: "thanks for the patch",
      user: { login: "linus" },
      html_url: "https://gitea.example.com/acme/widgets/pulls/7#issuecomment-1002",
      created_at: "2026-02-04T00:00:00Z",
      updated_at: "2026-02-04T00:00:00Z",
      issue_url: "",
      pull_request_url: "https://gitea.example.com/api/v1/repos/acme/widgets/pulls/7",
    };

    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [] },
        "/repos/acme/widgets/issues/comments": { body: [issueComment, prComment] },
        "/repos/acme/widgets/pulls?": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });

    const result = await connector.sync({ dryRun: true, include: ["comments"] });
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["gitea.issue.comment", "gitea.pr.comment"]);
    expect(result.summary.details?.events_issue_comments).toBe(1);
    expect(result.summary.details?.events_pr_comments).toBe(1);
    // The PR comment's parent_number comes from pull_request_url, not the
    // empty issue_url — guards against the parent_number-0 regression.
    const prEp = result.episodes.find((e) => e.kind === "gitea.pr.comment");
    expect(prEp?.metadata?.parent_number).toBe(7);
  });

  it("skips REQUEST_REVIEW (a review request, not a review)", async () => {
    const reviewRequest = {
      id: 9,
      user: null,
      state: "REQUEST_REVIEW",
      body: "",
      html_url: "https://gitea.example.com/acme/widgets/pulls/7#review-9",
      submitted_at: "2026-02-02T00:00:00Z",
    };
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls/7/reviews": { body: [reviewRequest] },
        "/repos/acme/widgets/pulls?": { body: [PR] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs", "reviews"] });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitea.pr.merged"]);
    expect(result.summary.details?.events_pr_reviews).toBe(0);
  });

  it("maps a PR review", async () => {
    const review = {
      id: 1,
      user: { login: "ada" },
      state: "APPROVED",
      body: "lgtm",
      html_url: "https://gitea.example.com/acme/widgets/pulls/7#review-1",
      submitted_at: "2026-02-02T00:00:00Z",
    };
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls/7/reviews": { body: [review] },
        "/repos/acme/widgets/pulls?": { body: [PR] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({ dryRun: true, include: ["prs", "reviews"] });
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["gitea.pr.merged", "gitea.pr.review"]);
    expect(result.summary.details?.events_pr_reviews).toBe(1);
  });

  it("respects --max-items by reporting skipped count", async () => {
    const issues = [1, 2, 3, 4, 5].map((n) => ({
      ...ISSUE,
      number: n,
      html_url: `https://gitea.example.com/acme/widgets/issues/${n}`,
    }));
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: issues },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls?": { body: [] },
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
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/widgets/issues?": { body: [ISSUE] },
        "/repos/acme/widgets/issues/comments": { body: [] },
        "/repos/acme/widgets/pulls?": { body: [PR] },
        "/repos/acme/widgets/pulls/7/reviews": { body: [] },
        "/repos/acme/widgets/releases": { body: [] },
      }),
    });
    const result = await connector.sync({
      dryRun: true,
      include: ["issues", "prs"],
      exclude: ["prs"],
    });
    expect(result.episodes.map((e) => e.kind)).toEqual(["gitea.issue.opened"]);
  });

  it("surfaces a clear ConnectorError when Gitea returns 404", async () => {
    const connector = createGiteaConnector({
      repo: "acme/missing",
      baseUrl: HOST,
      fetchImpl: fakeFetch({
        "/repos/acme/missing/issues?": { body: { message: "Not Found" }, opts: { status: 404 } },
      }),
    });
    await expect(connector.sync({ dryRun: true, include: ["issues"] })).rejects.toMatchObject({
      name: "ConnectorError",
      code: "not_found",
      connector: "gitea",
    });
  });

  it("surfaces a rate-limit error when x-ratelimit-remaining is 0", async () => {
    const connector = createGiteaConnector({
      repo: "acme/widgets",
      baseUrl: HOST,
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
