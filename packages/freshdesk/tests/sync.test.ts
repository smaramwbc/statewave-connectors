import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createFreshdeskConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: unknown;
  status?: number;
}

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

const ME = { id: 1, contact: { name: "API User", email: "api@acme.example" } };

describe("createFreshdeskConnector — config validation", () => {
  it("requires a subdomain", () => {
    expect(() =>
      createFreshdeskConnector({
        // @ts-expect-error testing the runtime guard
        subdomain: undefined,
        apiKey: "k",
      }),
    ).toThrow(ConnectorError);
  });

  it("requires an apiKey", () => {
    expect(() =>
      createFreshdeskConnector({
        subdomain: "acme",
        // @ts-expect-error testing the runtime guard
        apiKey: undefined,
      }),
    ).toThrow(ConnectorError);
  });
});

describe("createFreshdeskConnector — sync", () => {
  it("emits freshdesk.ticket.created on customer:<company_id>", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/agents/me": { body: ME },
      "/api/v2/tickets?per_page": {
        body: [
          {
            id: 1,
            subject: "Login failing",
            description_text: "500 on /login",
            status: 2,
            requester_id: 100,
            company_id: 7,
            created_at: "2026-05-09T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
          {
            id: 2,
            subject: "Slow dashboard",
            description_text: "Charts take 10s",
            status: 2,
            requester_id: 101,
            company_id: null,
            created_at: "2026-05-09T08:10:00.000Z",
            updated_at: "2026-05-09T08:10:00.000Z",
          },
        ],
      },
      "/api/v2/contacts/100": {
        body: { id: 100, name: "Ada", email: "ada@acme.example", company_id: 7 },
      },
      "/api/v2/contacts/101": {
        body: { id: 101, name: "Bob", email: "bob@example.com", company_id: null },
      },
      "/api/v2/companies/7": { body: { id: 7, name: "Acme" } },
    });

    const connector = createFreshdeskConnector({
      subdomain: "acme",
      apiKey: "tok",
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes.map((e) => e.kind)).toEqual([
      "freshdesk.ticket.created",
      "freshdesk.ticket.created",
    ]);
    const subjects = result.episodes.map((e) => e.subject).sort();
    expect(subjects).toEqual(["customer:101", "customer:7"]);
    expect(result.summary.details?.tickets_synced).toBe(2);
    expect(result.summary.details?.events_ticket_created).toBe(2);
  });

  it("emits freshdesk.ticket.resolved for resolved + closed tickets", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/agents/me": { body: ME },
      "/api/v2/tickets?per_page": {
        body: [
          {
            id: 10,
            subject: "Resolved bug",
            status: 4, // resolved
            requester_id: 200,
            created_at: "2026-05-08T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
          {
            id: 11,
            subject: "Closed bug",
            status: 5, // closed
            requester_id: 201,
            created_at: "2026-05-07T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
          {
            id: 12,
            subject: "Open bug",
            status: 2, // open
            requester_id: 202,
            created_at: "2026-05-09T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
        ],
      },
      "/api/v2/contacts/200": { body: { id: 200, name: "U200" } },
      "/api/v2/contacts/201": { body: { id: 201, name: "U201" } },
      "/api/v2/contacts/202": { body: { id: 202, name: "U202" } },
    });

    const connector = createFreshdeskConnector({ subdomain: "acme", apiKey: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    const kinds = result.episodes.map((e) => e.kind).sort();
    // 3 created + 2 resolved (resolved + closed)
    expect(kinds).toEqual([
      "freshdesk.ticket.created",
      "freshdesk.ticket.created",
      "freshdesk.ticket.created",
      "freshdesk.ticket.resolved",
      "freshdesk.ticket.resolved",
    ]);
    expect(result.summary.details?.events_ticket_resolved).toBe(2);
  });

  it("opts into per-ticket conversations via --include tickets,conversations", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/agents/me": { body: ME },
      "/api/v2/tickets?per_page": {
        body: [
          {
            id: 50,
            subject: "Conversation-bearing",
            description_text: "first body",
            status: 2,
            requester_id: 500,
            created_at: "2026-05-09T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
        ],
      },
      "/api/v2/contacts/500": { body: { id: 500, name: "Cid" } },
      "/api/v2/tickets/50/conversations": {
        body: [
          {
            id: 1000,
            ticket_id: 50,
            private: false,
            body_text: "Reproduced",
            user_id: 500,
            incoming: true,
            source: 1,
            created_at: "2026-05-09T08:05:00.000Z",
          },
          {
            id: 1001,
            ticket_id: 50,
            private: true,
            body_text: "internal hand-off",
            user_id: 555,
            source: 2,
            created_at: "2026-05-09T08:10:00.000Z",
          },
        ],
      },
    });

    const defaultRun = await createFreshdeskConnector({
      subdomain: "acme",
      apiKey: "tok",
      fetchImpl,
    }).sync({ dryRun: true });
    expect(defaultRun.episodes.map((e) => e.kind)).toEqual(["freshdesk.ticket.created"]);

    const withConversations = await createFreshdeskConnector({
      subdomain: "acme",
      apiKey: "tok",
      fetchImpl,
    }).sync({ dryRun: true, include: ["tickets", "conversations"] });
    const kinds = withConversations.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "freshdesk.conversation.internal_note",
      "freshdesk.conversation.posted",
      "freshdesk.ticket.created",
    ]);
    expect(withConversations.summary.details?.events_conversation_public).toBe(1);
    expect(withConversations.summary.details?.events_conversation_internal).toBe(1);
  });

  it("uses Basic auth with <api_key>:X", async () => {
    let captured = "";
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.Authorization) captured = headers.Authorization;
      if (u.includes("/api/v2/agents/me")) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes("/api/v2/tickets")) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createFreshdeskConnector({
      subdomain: "acme",
      apiKey: "supersecret",
      fetchImpl,
    }).sync({ dryRun: true });
    expect(captured.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(captured.slice("Basic ".length), "base64").toString("utf8");
    expect(decoded).toBe("supersecret:X");
  });

  it("translates 401 into auth_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ description: "Validation failed" }), { status: 401 });
    }) as typeof fetch;

    const connector = createFreshdeskConnector({
      subdomain: "acme",
      apiKey: "tok",
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/401/);
  });

  it("normalizes status code 6 to waiting_on_customer in metadata", async () => {
    const fetchImpl = fakeFetch({
      "/api/v2/agents/me": { body: ME },
      "/api/v2/tickets?per_page": {
        body: [
          {
            id: 60,
            subject: "Waiting",
            status: 6,
            requester_id: 600,
            created_at: "2026-05-09T08:00:00.000Z",
            updated_at: "2026-05-09T08:00:00.000Z",
          },
        ],
      },
      "/api/v2/contacts/600": { body: { id: 600 } },
    });

    const connector = createFreshdeskConnector({ subdomain: "acme", apiKey: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes[0]?.metadata?.ticket_status).toBe("waiting_on_customer");
    expect(result.episodes[0]?.metadata?.ticket_status_code).toBe(6);
  });

  it("passes --since through as `updated_since` server-side filter (v0.1.1)", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (u: RequestInfo | URL): Promise<Response> => {
      const ustr = typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
      if (ustr.includes("/api/v2/agents/me")) return new Response(JSON.stringify(ME), { status: 200 });
      if (ustr.includes("/api/v2/tickets")) {
        capturedUrl = ustr;
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createFreshdeskConnector({ subdomain: "acme", apiKey: "tok", fetchImpl }).sync({
      dryRun: true,
      since: "2026-01-01",
    });
    // Encoded ISO-8601 in the URL — colon → %3A
    expect(capturedUrl).toContain("updated_since=2026-01-01T00%3A00%3A00.000Z");
  });
});
