import { describe, it, expect } from "vitest";
import { Buffer as NodeBuffer } from "node:buffer";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createGmailConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: unknown;
  status?: number;
}

function fakeFetch(handlers: Record<string, FakeResponseSpec>): typeof fetch {
  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, spec] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        const body = typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
        return new Response(body, {
          status: spec.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no_handler", url: u }), { status: 404 });
  }) as typeof fetch;
}

const TOKEN_OK = {
  access_token: "ya29.fake-access-token",
  expires_in: 3600,
  token_type: "Bearer",
};

function b64url(s: string): string {
  return NodeBuffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const SAMPLE_INBOUND = {
  id: "msg_in_1",
  threadId: "thr_a",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: "1746777600000", // 2026-05-09T08:00:00.000Z
  snippet: "Quick question",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Alice <alice@acme.example>" },
      { name: "To", value: "team@statewave.ai" },
      { name: "Subject", value: "Login regression" },
      { name: "Date", value: "Mon, 9 May 2026 08:00:00 +0000" },
      { name: "Message-ID", value: "<msg_in_1@mail.acme.example>" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: b64url("Users are seeing 500s on /login since the deploy.") },
      },
      {
        mimeType: "text/html",
        body: { data: b64url("<p>Users are seeing 500s on /login since the deploy.</p>") },
      },
    ],
  },
};

const SAMPLE_OUTBOUND = {
  id: "msg_out_1",
  threadId: "thr_a",
  labelIds: ["SENT"],
  internalDate: "1746779400000",
  snippet: "Reproduced",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "team@statewave.ai" },
      { name: "To", value: "Alice <alice@acme.example>" },
      { name: "Subject", value: "Re: Login regression" },
      { name: "Date", value: "Mon, 9 May 2026 08:30:00 +0000" },
    ],
    body: { data: b64url("Reproduced. Rolling back now.") },
  },
};

const HTML_ONLY = {
  id: "msg_html",
  threadId: "thr_b",
  labelIds: ["INBOX"],
  internalDate: "1746777600000",
  payload: {
    mimeType: "text/html",
    headers: [
      { name: "From", value: "marketing@news.example" },
      { name: "Subject", value: "Newsletter" },
    ],
    body: {
      data: b64url(
        "<html><body><h1>Hello</h1><p>This week's update.</p><script>alert(1)</script></body></html>",
      ),
    },
  },
};

describe("createGmailConnector — config validation", () => {
  it("requires a query", () => {
    expect(() =>
      createGmailConnector({
        // @ts-expect-error testing the runtime guard
        query: undefined,
        credentials: { clientId: "x", clientSecret: "y", refreshToken: "z" },
      }),
    ).toThrow(ConnectorError);
  });

  it("requires credentials", () => {
    expect(() =>
      createGmailConnector({
        query: "label:inbox",
        // @ts-expect-error testing the runtime guard
        credentials: { clientId: "", clientSecret: "", refreshToken: "" },
      }),
    ).toThrow(ConnectorError);
  });
});

describe("createGmailConnector — sync", () => {
  it("emits gmail.message.received and gmail.message.sent on relationship:<email>", async () => {
    const fetchImpl = fakeFetch({
      "https://oauth2.googleapis.com/token": { body: TOKEN_OK },
      "/gmail/v1/users/me/messages?": {
        body: {
          messages: [
            { id: "msg_in_1", threadId: "thr_a" },
            { id: "msg_out_1", threadId: "thr_a" },
          ],
          resultSizeEstimate: 2,
        },
      },
      "/gmail/v1/users/me/messages/msg_in_1?format=full": { body: SAMPLE_INBOUND },
      "/gmail/v1/users/me/messages/msg_out_1?format=full": { body: SAMPLE_OUTBOUND },
    });

    const connector = createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes).toHaveLength(2);
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["gmail.message.received", "gmail.message.sent"]);
    for (const ep of result.episodes) {
      expect(ep.subject).toBe("relationship:alice@acme.example");
    }
    expect(result.summary.details?.events_message_received).toBe(1);
    expect(result.summary.details?.events_message_sent).toBe(1);
  });

  it("extracts text/plain bodies and uses them in episode text", async () => {
    const fetchImpl = fakeFetch({
      "https://oauth2.googleapis.com/token": { body: TOKEN_OK },
      "/gmail/v1/users/me/messages?": {
        body: { messages: [{ id: "msg_in_1", threadId: "thr_a" }] },
      },
      "/gmail/v1/users/me/messages/msg_in_1?format=full": { body: SAMPLE_INBOUND },
    });
    const connector = createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes[0]?.text).toContain("500s on /login since the deploy");
  });

  it("strips HTML when only an html body is available", async () => {
    const fetchImpl = fakeFetch({
      "https://oauth2.googleapis.com/token": { body: TOKEN_OK },
      "/gmail/v1/users/me/messages?": {
        body: { messages: [{ id: "msg_html", threadId: "thr_b" }] },
      },
      "/gmail/v1/users/me/messages/msg_html?format=full": { body: HTML_ONLY },
    });
    const connector = createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    const text = result.episodes[0]?.text ?? "";
    expect(text).toContain("Hello");
    expect(text).toContain("This week's update.");
    // The script content must be dropped along with the tags.
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("<");
  });

  it("exchanges refresh token for an access token via the OAuth endpoint", async () => {
    let oauthCalled = false;
    let oauthBody = "";
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const ustr = typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
      if (ustr.includes("oauth2.googleapis.com/token")) {
        oauthCalled = true;
        oauthBody = (init?.body as string) ?? "";
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      if (ustr.includes("/messages"))
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "my-id", clientSecret: "my-secret", refreshToken: "my-refresh" },
      fetchImpl,
    }).sync({ dryRun: true });

    expect(oauthCalled).toBe(true);
    expect(oauthBody).toContain("grant_type=refresh_token");
    expect(oauthBody).toContain("client_id=my-id");
    expect(oauthBody).toContain("client_secret=my-secret");
    expect(oauthBody).toContain("refresh_token=my-refresh");
  });

  it("uses the access token as a Bearer Authorization header", async () => {
    let captured = "";
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const ustr = typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
      if (ustr.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      if (ustr.includes("/messages")) {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Authorization) captured = headers.Authorization;
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    }).sync({ dryRun: true });
    expect(captured).toBe("Bearer ya29.fake-access-token");
  });

  it("translates 401 from the Gmail API into auth_failed", async () => {
    const fetchImpl = (async (u: RequestInfo | URL): Promise<Response> => {
      const ustr = typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
      if (ustr.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 });
    }) as typeof fetch;

    const connector = createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/401/);
  });

  it("translates 401 from the OAuth endpoint into auth_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;

    const connector = createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/400/);
  });

  it("pushes --label-ids through as repeated labelIds query parameters (v0.1.1)", async () => {
    let listUrl = "";
    const fetchImpl = (async (u: RequestInfo | URL): Promise<Response> => {
      const ustr = typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
      if (ustr.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify(TOKEN_OK), { status: 200 });
      }
      if (ustr.includes("/messages?")) {
        listUrl = ustr;
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createGmailConnector({
      query: "label:inbox",
      credentials: { clientId: "cid", clientSecret: "csec", refreshToken: "rtok" },
      labelIds: ["INBOX", "IMPORTANT"],
      fetchImpl,
    }).sync({ dryRun: true });
    // Repeated query parameters: labelIds=INBOX&labelIds=IMPORTANT
    expect(listUrl).toContain("labelIds=INBOX");
    expect(listUrl).toContain("labelIds=IMPORTANT");
  });
});
