import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createZendeskConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: unknown;
  status?: number;
}

/** Route by path-suffix substring match. */
function fakeFetch(handlers: Record<string, FakeResponseSpec>): typeof fetch {
  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, spec] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        return new Response(JSON.stringify(spec.body), {
          status: spec.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no_handler", url: u }), { status: 404 });
  }) as typeof fetch;
}

const ME = {
  user: { id: 1, name: "API User", email: "api@acme.example" },
};

describe("createZendeskConnector — config validation", () => {
  it("requires a subdomain", () => {
    expect(() =>
      createZendeskConnector({
        // @ts-expect-error testing the runtime guard
        subdomain: undefined,
        auth: { mode: "api_token", email: "a@b", apiToken: "t" },
      }),
    ).toThrow(ConnectorError);
  });

  it("requires auth", () => {
    expect(() =>
      createZendeskConnector({
        subdomain: "acme",
        // @ts-expect-error testing the runtime guard
        auth: undefined,
      }),
    ).toThrow(ConnectorError);
  });

  it("api_token mode requires email + token", () => {
    // The auth header is built at construction time, so the guard surfaces
    // synchronously — same shape as the missing-subdomain check above.
    expect(() =>
      createZendeskConnector({
        subdomain: "acme",
        auth: { mode: "api_token", email: "", apiToken: "" },
      }),
    ).toThrow(ConnectorError);
  });
});

describe("createZendeskConnector — sync", () => {
  it("emits zendesk.ticket.created for each ticket on customer:<org_id>", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/users/me.json": { body: ME },
      "/api/v2/tickets.json": {
        body: {
          tickets: [
            {
              id: 1,
              subject: "Login failing",
              description: "500 on /login",
              status: "open",
              requester_id: 100,
              organization_id: 7,
              created_at: "2026-05-09T08:00:00.000Z",
              updated_at: "2026-05-09T08:00:00.000Z",
            },
            {
              id: 2,
              subject: "Slow dashboard",
              description: "Charts take 10s",
              status: "open",
              requester_id: 101,
              organization_id: null,
              created_at: "2026-05-09T08:10:00.000Z",
              updated_at: "2026-05-09T08:10:00.000Z",
            },
          ],
          meta: { has_more: false },
        },
      },
      "/api/v2/organizations/show_many.json": {
        body: { organizations: [{ id: 7, name: "Acme Industries" }] },
      },
    });

    const connector = createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "api@acme.example", apiToken: "tok" },
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });

    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.map((e) => e.kind)).toEqual([
      "zendesk.ticket.created",
      "zendesk.ticket.created",
    ]);
    const subjects = result.episodes.map((e) => e.subject).sort();
    expect(subjects).toEqual(["customer:101", "customer:7"]);
    expect(result.summary.details?.tickets_synced).toBe(2);
    expect(result.summary.details?.events_ticket_created).toBe(2);
  });

  it("emits zendesk.ticket.solved for solved/closed tickets", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/users/me.json": { body: ME },
      "/api/v2/tickets.json": {
        body: {
          tickets: [
            {
              id: 10,
              subject: "Resolved bug",
              status: "solved",
              requester_id: 200,
              created_at: "2026-05-08T08:00:00.000Z",
              updated_at: "2026-05-09T08:00:00.000Z",
            },
            {
              id: 11,
              subject: "Closed bug",
              status: "closed",
              requester_id: 201,
              created_at: "2026-05-07T08:00:00.000Z",
              updated_at: "2026-05-09T08:00:00.000Z",
            },
            {
              id: 12,
              subject: "Open bug",
              status: "open",
              requester_id: 202,
              created_at: "2026-05-09T08:00:00.000Z",
              updated_at: "2026-05-09T08:00:00.000Z",
            },
          ],
          meta: { has_more: false },
        },
      },
      "/api/v2/organizations/show_many.json": { body: { organizations: [] } },
    });

    const connector = createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "a", apiToken: "b" },
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    const kinds = result.episodes.map((e) => e.kind).sort();
    // 3 created + 2 solved
    expect(kinds).toEqual([
      "zendesk.ticket.created",
      "zendesk.ticket.created",
      "zendesk.ticket.created",
      "zendesk.ticket.solved",
      "zendesk.ticket.solved",
    ]);
    expect(result.summary.details?.events_ticket_solved).toBe(2);
  });

  it("skips comment ingestion by default; opts in via --include comments", async () => {
    const handlers: Record<string, FakeResponseSpec> = {
      "/api/v2/users/me.json": { body: ME },
      "/api/v2/tickets.json": {
        body: {
          tickets: [
            {
              id: 50,
              subject: "Comment-bearing",
              status: "open",
              requester_id: 500,
              created_at: "2026-05-09T08:00:00.000Z",
              updated_at: "2026-05-09T08:00:00.000Z",
            },
          ],
          meta: { has_more: false },
        },
      },
      "/api/v2/tickets/50/comments.json": {
        body: {
          comments: [
            {
              id: 1000,
              public: true,
              body: "Reproduced",
              author_id: 500,
              created_at: "2026-05-09T08:05:00.000Z",
            },
            {
              id: 1001,
              public: false,
              body: "internal hand-off",
              author_id: 555,
              created_at: "2026-05-09T08:10:00.000Z",
            },
          ],
          meta: { has_more: false },
        },
      },
      "/api/v2/organizations/show_many.json": { body: { organizations: [] } },
    };
    const fetchImpl = fakeFetch(handlers);

    const defaultRun = await createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "a", apiToken: "b" },
      fetchImpl,
    }).sync({ dryRun: true });
    expect(defaultRun.episodes.map((e) => e.kind)).toEqual(["zendesk.ticket.created"]);

    const withComments = await createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "a", apiToken: "b" },
      fetchImpl,
    }).sync({ dryRun: true, include: ["tickets", "comments"] });
    const kinds = withComments.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "zendesk.comment.internal_note",
      "zendesk.comment.posted",
      "zendesk.ticket.created",
    ]);
    expect(withComments.summary.details?.events_comment_public).toBe(1);
    expect(withComments.summary.details?.events_comment_internal).toBe(1);
  });

  it("uses Bearer auth when given an OAuth token", async () => {
    let captured = "";
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization) captured = headers.Authorization;
      if (u.includes("/users/me.json")) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes("/tickets.json"))
        return new Response(JSON.stringify({ tickets: [], meta: { has_more: false } }), { status: 200 });
      if (u.includes("/organizations/show_many.json"))
        return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "oauth", accessToken: "abc-123" },
      fetchImpl,
    }).sync({ dryRun: true });
    expect(captured).toBe("Bearer abc-123");
  });

  it("uses Basic auth in api_token mode with the /token suffix", async () => {
    let captured = "";
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization) captured = headers.Authorization;
      if (u.includes("/users/me.json")) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes("/tickets.json"))
        return new Response(JSON.stringify({ tickets: [], meta: { has_more: false } }), { status: 200 });
      if (u.includes("/organizations/show_many.json"))
        return new Response(JSON.stringify({ organizations: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "agent@acme.example", apiToken: "tok-xyz" },
      fetchImpl,
    }).sync({ dryRun: true });
    expect(captured.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(captured.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("agent@acme.example/token:tok-xyz");
  });

  it("translates 401 into auth_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "Couldn't authenticate" }), { status: 401 });
    }) as typeof fetch;

    const connector = createZendeskConnector({
      subdomain: "acme",
      auth: { mode: "api_token", email: "a", apiToken: "b" },
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/401/);
  });
});
