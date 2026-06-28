import { describe, it, expect } from "vitest";
import { JiraClient } from "../src/index.js";
import type { RawIssue } from "../src/index.js";

const BASE = "https://acme.atlassian.net";

/** Mock fetch that returns a queued response per call and records method/url/body. */
function sequenceFetch(responses: ReadonlyArray<unknown>): {
  fetchImpl: typeof fetch;
  calls: () => Array<{ url: string; method: string; body: Record<string, unknown> | undefined }>;
} {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> =
    [];
  let i = 0;
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", body });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function issue(key: string): RawIssue {
  return {
    key,
    fields: {
      summary: `summary ${key}`,
      status: { name: "Open", statusCategory: { key: "new" } },
      project: { key: "ENG" },
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
  };
}

function cloudClient(fetchImpl: typeof fetch): JiraClient {
  // Default deployment is cloud.
  return new JiraClient({ baseUrl: BASE, email: "you@acme.com", apiToken: "tok", fetchImpl });
}

describe("Jira Cloud search — POST /search/jql (CHANGE-2046 migration, closes #233)", () => {
  it("POSTs to /rest/api/3/search/jql with a JSON body, not the removed GET /search", async () => {
    const { fetchImpl, calls } = sequenceFetch([{ issues: [issue("ENG-1")] }]);
    const result = await cloudClient(fetchImpl).searchIssues({ projects: ["ENG"], max: 50 });

    const c = calls()[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${BASE}/rest/api/3/search/jql`);
    // The removed endpoint and its startAt cursor must be gone.
    expect(c.url).not.toContain("startAt");
    expect(c.body?.startAt).toBeUndefined();
    // `fields` is an ARRAY on the new endpoint (was a CSV query param).
    expect(Array.isArray(c.body?.fields)).toBe(true);
    expect(c.body?.fields).toContain("summary");
    expect(typeof c.body?.jql).toBe("string");
    expect(result.map((r) => r.key)).toEqual(["ENG-1"]);
  });

  it("follows nextPageToken across pages and stops when the token is absent", async () => {
    const { fetchImpl, calls } = sequenceFetch([
      { issues: [issue("ENG-1"), issue("ENG-2")], nextPageToken: "tok-page-2" },
      { issues: [issue("ENG-3")] }, // last page: no nextPageToken
    ]);
    const issues = await cloudClient(fetchImpl).searchIssues({ projects: ["ENG"], max: 50 });

    expect(issues.map((i) => i.key)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    const c = calls();
    expect(c.length).toBe(2); // stopped after the token-less page; no third request
    expect(c[0].body?.nextPageToken).toBeUndefined(); // first page sends no token
    expect(c[1].body?.nextPageToken).toBe("tok-page-2"); // second page echoes it back
  });

  it("stops on an empty page (no total to rely on)", async () => {
    const { fetchImpl, calls } = sequenceFetch([{ issues: [] }]);
    const issues = await cloudClient(fetchImpl).searchIssues({ projects: ["ENG"], max: 50 });

    expect(issues).toEqual([]);
    expect(calls().length).toBe(1);
  });

  it("includes expand: 'changelog' in the body when changelog is requested", async () => {
    const { fetchImpl, calls } = sequenceFetch([{ issues: [issue("ENG-1")] }]);
    await cloudClient(fetchImpl).searchIssuesDetailed({
      projects: ["ENG"],
      max: 50,
      expandChangelog: true,
    });
    expect(calls()[0].body?.expand).toBe("changelog");
  });
});
