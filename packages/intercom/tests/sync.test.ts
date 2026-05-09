import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createIntercomConnector } from "../src/index.js";

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

const ME = { type: "admin", id: "admin_1", name: "API User", email: "api@acme.example" };

describe("createIntercomConnector — config validation", () => {
  it("requires an accessToken", () => {
    expect(() =>
      createIntercomConnector({
        // @ts-expect-error testing the runtime guard
        accessToken: undefined,
      }),
    ).toThrow(ConnectorError);
  });

  it("rejects an unknown region", () => {
    expect(() =>
      createIntercomConnector({
        accessToken: "tok",
        // @ts-expect-error testing the runtime guard
        region: "uk",
      }),
    ).toThrow(ConnectorError);
  });
});

describe("createIntercomConnector — sync", () => {
  it("emits intercom.conversation.created on customer:<company_id>", async () => {
    const fetchImpl = fakeFetch({
      "/me": { body: ME },
      "/conversations?per_page": {
        body: {
          type: "conversation.list",
          conversations: [
            {
              id: "1",
              created_at: 1746777600,
              updated_at: 1746777600,
              state: "open",
              source: { body: "Login broken", subject: "Login failure", type: "conversation" },
              contacts: { contacts: [{ id: "c1", type: "user" }] },
            },
          ],
          pages: { type: "pages", next: null },
        },
      },
      "/contacts/c1": {
        body: {
          type: "contact",
          id: "c1",
          name: "Ada Lovelace",
          email: "ada@acme.example",
          companies: { type: "company.list", data: [{ id: "co1" }] },
        },
      },
      "/companies/co1": { body: { id: "co1", name: "Acme" } },
    });

    const connector = createIntercomConnector({
      accessToken: "tok",
      region: "us",
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.kind).toBe("intercom.conversation.created");
    expect(result.episodes[0]?.subject).toBe("customer:co1");
    expect(result.episodes[0]?.text).toContain("Ada Lovelace");
    expect(result.episodes[0]?.metadata?.primary_company_name).toBe("Acme");
    expect(result.summary.details?.conversations_synced).toBe(1);
  });

  it("falls back to customer:<contact_id> when no company on the contact", async () => {
    const fetchImpl = fakeFetch({
      "/me": { body: ME },
      "/conversations?per_page": {
        body: {
          type: "conversation.list",
          conversations: [
            {
              id: "2",
              created_at: 1746777600,
              updated_at: 1746777600,
              state: "open",
              source: { body: "Hi" },
              contacts: { contacts: [{ id: "c2", type: "user" }] },
            },
          ],
          pages: { type: "pages", next: null },
        },
      },
      "/contacts/c2": {
        body: {
          type: "contact",
          id: "c2",
          name: "Bob",
          companies: { type: "company.list", data: [] },
        },
      },
    });

    const connector = createIntercomConnector({ accessToken: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes[0]?.subject).toBe("customer:c2");
  });

  it("emits intercom.conversation.closed for closed conversations", async () => {
    const fetchImpl = fakeFetch({
      "/me": { body: ME },
      "/conversations?per_page": {
        body: {
          type: "conversation.list",
          conversations: [
            {
              id: "10",
              created_at: 1746777600,
              updated_at: 1746864000,
              state: "closed",
              source: { body: "Closed already" },
              contacts: { contacts: [{ id: "c10", type: "user" }] },
            },
            {
              id: "11",
              created_at: 1746777600,
              updated_at: 1746864000,
              state: "open",
              source: { body: "Still open" },
              contacts: { contacts: [{ id: "c11", type: "user" }] },
            },
          ],
          pages: { type: "pages", next: null },
        },
      },
      "/contacts/c10": {
        body: { type: "contact", id: "c10", companies: { data: [] } },
      },
      "/contacts/c11": {
        body: { type: "contact", id: "c11", companies: { data: [] } },
      },
    });

    const connector = createIntercomConnector({ accessToken: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    const kinds = result.episodes.map((e) => e.kind).sort();
    // 2 created + 1 closed (only the conv 10)
    expect(kinds).toEqual([
      "intercom.conversation.closed",
      "intercom.conversation.created",
      "intercom.conversation.created",
    ]);
    expect(result.summary.details?.events_conversation_closed).toBe(1);
  });

  it("opts into per-conversation parts via --include conversations,parts", async () => {
    const fetchImpl = fakeFetch({
      "/me": { body: ME },
      "/conversations?per_page": {
        body: {
          type: "conversation.list",
          conversations: [
            {
              id: "20",
              created_at: 1746777600,
              updated_at: 1746864000,
              state: "open",
              source: { body: "Initial" },
              contacts: { contacts: [{ id: "c20", type: "user" }] },
            },
          ],
          pages: { type: "pages", next: null },
        },
      },
      "/contacts/c20": {
        body: { type: "contact", id: "c20", companies: { data: [] } },
      },
      "/conversations/20?display_as=plaintext": {
        body: {
          id: "20",
          created_at: 1746777600,
          updated_at: 1746864000,
          state: "open",
          source: { body: "Initial" },
          conversation_parts: {
            conversation_parts: [
              {
                id: "p1",
                part_type: "comment",
                body: "Reproduced",
                created_at: 1746781200,
                author: { type: "admin", id: "admin_1", name: "Grace" },
              },
              {
                id: "p2",
                part_type: "note",
                body: "Hand off to platform team",
                created_at: 1746784800,
                author: { type: "admin", id: "admin_2", name: "Margaret" },
              },
              {
                id: "p3",
                part_type: "assignment",
                body: null,
                created_at: 1746788400,
                author: { type: "admin", id: "admin_2" },
              },
              {
                id: "p4",
                part_type: "comment",
                body: "",
                created_at: 1746791000,
                author: { type: "user", id: "c20" },
              },
            ],
          },
        },
      },
    });

    const connector = createIntercomConnector({ accessToken: "tok", fetchImpl });
    const defaultRun = await connector.sync({ dryRun: true });
    expect(defaultRun.episodes.map((e) => e.kind)).toEqual(["intercom.conversation.created"]);

    const withParts = await createIntercomConnector({ accessToken: "tok", fetchImpl }).sync({
      dryRun: true,
      include: ["conversations", "parts"],
    });
    const kinds = withParts.episodes.map((e) => e.kind).sort();
    // 1 created + 1 reply (p1) + 1 note (p2). p3 is a system part (skipped),
    // p4 has empty body (skipped).
    expect(kinds).toEqual([
      "intercom.conversation.created",
      "intercom.conversation.note_added",
      "intercom.conversation.replied",
    ]);
    expect(withParts.summary.details?.events_reply).toBe(1);
    expect(withParts.summary.details?.events_note).toBe(1);
  });

  it("uses Bearer auth + Intercom-Version header", async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) captured = { ...captured, ...headers };
      if (u.includes("/me")) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes("/conversations?per_page"))
        return new Response(
          JSON.stringify({ type: "conversation.list", conversations: [], pages: { next: null } }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createIntercomConnector({ accessToken: "tok-xyz", fetchImpl }).sync({ dryRun: true });
    expect(captured.Authorization).toBe("Bearer tok-xyz");
    expect(captured["Intercom-Version"]).toBe("2.13");
  });

  it("routes EU workspaces to api.eu.intercom.io", async () => {
    let host = "";
    const fetchImpl = (async (url: RequestInfo | URL): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      try {
        host = new URL(u).host;
      } catch {
        // ignore — URL might be malformed in pathological tests
      }
      if (u.includes("/me")) return new Response(JSON.stringify(ME), { status: 200 });
      if (u.includes("/conversations"))
        return new Response(
          JSON.stringify({ type: "conversation.list", conversations: [], pages: { next: null } }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createIntercomConnector({ accessToken: "tok", region: "eu", fetchImpl }).sync({
      dryRun: true,
    });
    expect(host).toBe("api.eu.intercom.io");
  });

  it("translates 401 into auth_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }) as typeof fetch;
    const connector = createIntercomConnector({ accessToken: "tok", fetchImpl });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/401/);
  });
});
