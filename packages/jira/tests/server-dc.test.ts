import { describe, it, expect } from "vitest";
import {
  JiraClient,
  flattenBody,
  normalizeRawIssue,
  userDisplay,
} from "../src/index.js";
import type { RawIssue } from "../src/index.js";

const BASE = "https://jira.onprem.example";

/** Capture the URL + headers a single request used, returning a canned body. */
function captureFetch(body: unknown): {
  fetchImpl: typeof fetch;
  last: () => { url: string; auth: string | null };
} {
  let url = "";
  let auth: string | null = null;
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    url = u;
    const h = new Headers(init?.headers);
    auth = h.get("Authorization");
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, last: () => ({ url, auth }) };
}

describe("flattenBody (cloud ADF vs server plain-text)", () => {
  it("returns server plain-text/wiki strings as-is", () => {
    expect(flattenBody("h2. Heading\nplain server body")).toBe("h2. Heading\nplain server body");
    expect(flattenBody("")).toBe("");
    expect(flattenBody(null)).toBe("");
  });
  it("flattens a cloud ADF object", () => {
    expect(
      flattenBody({ type: "doc", content: [{ type: "text", text: "hello" }] }),
    ).toBe("hello");
  });
});

describe("userDisplay — server username fallback", () => {
  it("prefers displayName, then server name, then accountId, never email", () => {
    expect(userDisplay({ displayName: "Ada L", name: "ada" })).toBe("Ada L");
    expect(userDisplay({ name: "ada" })).toBe("ada");
    expect(userDisplay({ accountId: "acc1" })).toBe("acc1");
  });
});

describe("normalizeRawIssue — server plain-text body", () => {
  it("keeps a string description (server v2) and resolves the server name", () => {
    const raw: RawIssue = {
      key: "ENG-5",
      fields: {
        summary: "On-prem bug",
        description: "Steps:\n1. do x\n2. see error",
        status: { name: "Open", statusCategory: { key: "new" } },
        project: { key: "ENG" },
        reporter: { name: "bob", displayName: "Bob R" },
        created: "2026-01-01T00:00:00.000Z",
        updated: "2026-01-01T00:00:00.000Z",
      },
    };
    const issue = normalizeRawIssue(raw, BASE);
    expect(issue.description).toBe("Steps:\n1. do x\n2. see error");
    expect(issue.reporter).toBe("Bob R");
    expect(issue.url).toBe(`${BASE}/browse/ENG-5`);
  });
});

describe("JiraClient — deployment auth + REST path", () => {
  it("cloud (default): /rest/api/3 + Basic email:token", async () => {
    const { fetchImpl, last } = captureFetch({ total: 0, issues: [] });
    const client = new JiraClient({
      baseUrl: BASE,
      email: "you@acme.com",
      apiToken: "tok",
      fetchImpl,
    });
    await client.searchIssues({ projects: ["ENG"], max: 5 });
    const { url, auth } = last();
    expect(url).toContain("/rest/api/3/search");
    const expected = `Basic ${Buffer.from("you@acme.com:tok").toString("base64")}`;
    expect(auth).toBe(expected);
  });

  it("server + PAT: /rest/api/2 + Bearer", async () => {
    const { fetchImpl, last } = captureFetch({ total: 0, issues: [] });
    const client = new JiraClient({
      baseUrl: BASE,
      deployment: "server",
      personalAccessToken: "pat-123",
      fetchImpl,
    });
    await client.searchIssues({ projects: ["ENG"], max: 5 });
    const { url, auth } = last();
    expect(url).toContain("/rest/api/2/search");
    expect(auth).toBe("Bearer pat-123");
  });

  it("server + basic (username:password) when no PAT", async () => {
    const { fetchImpl, last } = captureFetch({ total: 0, issues: [] });
    const client = new JiraClient({
      baseUrl: BASE,
      deployment: "server",
      email: "svc",
      apiToken: "pw",
      fetchImpl,
    });
    await client.searchIssues({ projects: ["ENG"], max: 5 });
    expect(last().auth).toBe(`Basic ${Buffer.from("svc:pw").toString("base64")}`);
  });

  it("server with no credentials throws auth_missing", () => {
    expect(
      () => new JiraClient({ baseUrl: BASE, deployment: "server", fetchImpl: globalThis.fetch }),
    ).toThrow(/auth/i);
  });

  it("end-to-end: server v2 search yields plain-text description + name user", async () => {
    const { fetchImpl } = captureFetch({
      total: 1,
      issues: [
        {
          key: "OPS-1",
          fields: {
            summary: "disk full",
            description: "df shows 100% on /var",
            status: { name: "Done", statusCategory: { key: "done" } },
            project: { key: "OPS" },
            reporter: { name: "carol", displayName: "Carol Ops" },
            created: "2026-02-01T00:00:00.000Z",
            updated: "2026-02-02T00:00:00.000Z",
            resolutiondate: "2026-02-02T00:00:00.000Z",
          },
        },
      ],
    });
    const client = new JiraClient({
      baseUrl: BASE,
      deployment: "server",
      personalAccessToken: "pat",
      fetchImpl,
    });
    const issues = await client.searchIssues({ projects: ["OPS"], max: 10 });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.description).toBe("df shows 100% on /var");
    expect(issues[0]!.statusCategory).toBe("done");
    expect(issues[0]!.reporter).toBe("Carol Ops");
  });
});
