import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  createIntercomWebhookHandler,
  InMemoryIntercomDedupCache,
  type StatewaveIngest,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "shh-intercom";

function sign(body: string, secret = SECRET): string {
  return `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
}

function buildSignedRequest(
  body: string,
  options: { signature?: string; missingSignature?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!options.missingSignature) {
    headers["x-hub-signature"] = options.signature ?? sign(body);
  }
  return new Request("http://localhost/intercom/events", {
    method: "POST",
    headers,
    body,
  });
}

function buildConversation(overrides: Record<string, unknown> = {}) {
  return {
    type: "conversation",
    id: "convo_777",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_500,
    state: "open",
    priority: "priority",
    tags: { tags: [{ name: "billing" }] },
    source: {
      type: "conversation",
      id: "src_1",
      body: "Card declined when upgrading the plan.",
      subject: "Upgrade failure",
      author: { type: "user", id: "user_42", email: "alice@acme.example", name: "Alice" },
    },
    contacts: {
      contacts: [
        {
          type: "user",
          id: "user_42",
          name: "Alice",
          email: "alice@acme.example",
          external_id: "ext_alice",
          role: "user",
        },
      ],
    },
    conversation_parts: { conversation_parts: [] },
    assignee: { type: "admin", id: "admin_99" },
    team_assignee_id: "team_5",
    ...overrides,
  };
}

function buildEnvelope(topic: string, item: Record<string, unknown>, id = `notif_${topic}`) {
  return {
    type: "notification_event",
    id,
    app_id: "app_acme",
    topic,
    created_at: 1_700_000_001,
    data: { type: "notification_event_data", item },
  };
}

describe("createIntercomWebhookHandler — config", () => {
  it("rejects without signingSecret", () => {
    expect(() =>
      createIntercomWebhookHandler({
        // @ts-expect-error testing runtime guard
        signingSecret: undefined,
        ingest: vi.fn(),
      }),
    ).toThrow();
  });

  it("rejects without ingest sink AND statewaveUrl", () => {
    expect(() => createIntercomWebhookHandler({ signingSecret: SECRET })).toThrow();
  });
});

describe("createIntercomWebhookHandler — auth", () => {
  it("returns 401 when signature header is missing", async () => {
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const body = JSON.stringify(buildEnvelope("conversation.user.created", buildConversation()));
    const res = await handler(buildSignedRequest(body, { missingSignature: true }));
    expect(res.status).toBe(401);
  });

  it("returns 401 on bad signature", async () => {
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const body = JSON.stringify(buildEnvelope("conversation.user.created", buildConversation()));
    const res = await handler(buildSignedRequest(body, { signature: "sha1=deadbeef" }));
    expect(res.status).toBe(401);
  });

  it("accepts a custom signature header name", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      signatureHeader: "x-intercom-mac",
      ingest,
    });
    const body = JSON.stringify(buildEnvelope("conversation.user.created", buildConversation()));
    const req = new Request("http://localhost/intercom/events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-intercom-mac": sign(body) },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("intercom.conversation.created");
  });
});

describe("createIntercomWebhookHandler — dispatch", () => {
  it("ingests conversation.user.created", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      appId: "app_acme",
      ingest,
    });
    const body = JSON.stringify(
      buildEnvelope("conversation.user.created", buildConversation()),
    );
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("intercom.conversation.created");
    expect(captured?.subject).toBe("customer:user_42");
    expect(captured?.text).toContain("Alice opened conversation #convo_777");
    expect(captured?.text).toContain("Card declined");
    expect(captured?.source.url).toBe(
      "https://app.intercom.com/a/inbox/app_acme/inbox/conversation/convo_777",
    );
  });

  it("ingests conversation.admin.closed (state forced to closed)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const item = buildConversation({ state: "open" });
    const body = JSON.stringify(buildEnvelope("conversation.admin.closed", item));
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("intercom.conversation.closed");
    expect(captured?.metadata?.conversation_state).toBe("closed");
  });

  it("ingests conversation.user.replied (latest comment part)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const item = buildConversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p_1",
            part_type: "comment",
            body: "Earlier reply.",
            created_at: 1_700_000_100,
            author: { type: "user", id: "user_42", name: "Alice" },
          },
          {
            id: "p_2",
            part_type: "assignment",
            body: null,
            created_at: 1_700_000_150,
            author: { type: "admin", id: "admin_99", name: "Bob" },
          },
          {
            id: "p_3",
            part_type: "comment",
            body: "Tried again, still failing.",
            created_at: 1_700_000_200,
            author: { type: "user", id: "user_42", name: "Alice" },
          },
        ],
      },
    });
    const body = JSON.stringify(buildEnvelope("conversation.user.replied", item));
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("intercom.conversation.replied");
    expect(captured?.text).toContain("Tried again");
    expect(captured?.metadata?.part_id).toBe("p_3");
  });

  it("ingests conversation.admin.replied (admin comment)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const item = buildConversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p_admin_1",
            part_type: "comment",
            body: "Looking into it now.",
            created_at: 1_700_000_120,
            author: { type: "admin", id: "admin_99", name: "Bob" },
          },
        ],
      },
    });
    const body = JSON.stringify(buildEnvelope("conversation.admin.replied", item));
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("intercom.conversation.replied");
    expect(captured?.text).toContain("Bob");
  });

  it("ingests conversation.admin.noted (internal note)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const item = buildConversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p_note_1",
            part_type: "note",
            body: "Hand off to billing eng.",
            created_at: 1_700_000_130,
            author: { type: "admin", id: "admin_99", name: "Bob" },
          },
        ],
      },
    });
    const body = JSON.stringify(buildEnvelope("conversation.admin.noted", item));
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("intercom.conversation.note_added");
    expect(captured?.text).toContain("(internal note)");
  });

  it("falls back to last part when no matching part_type is present", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const item = buildConversation({
      conversation_parts: {
        conversation_parts: [
          {
            id: "p_fallback",
            part_type: "assignment",
            body: null,
            created_at: 1_700_000_140,
            author: { type: "admin", id: "admin_99", name: "Bob" },
          },
        ],
      },
    });
    const body = JSON.stringify(buildEnvelope("conversation.user.replied", item));
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(captured?.metadata?.part_id).toBe("p_fallback");
  });
});

describe("createIntercomWebhookHandler — tolerance & dedup", () => {
  it("ignores unsupported topics with 200 + 'unknown_topic'", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify(
      buildEnvelope("ping", { type: "ping" }),
    );
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("unknown_topic");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects envelopes missing id/topic with 200 + 'missing_envelope_fields'", async () => {
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const body = JSON.stringify({ type: "notification_event", data: { item: {} } });
    const res = await handler(buildSignedRequest(body));
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("missing_envelope_fields");
  });

  it("dedups retried deliveries by envelope id", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify(
      buildEnvelope("conversation.user.created", buildConversation(), "notif_dup_1"),
    );
    await handler(buildSignedRequest(body));
    const res2 = await handler(buildSignedRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
    const json = (await res2.json()) as { deduplicated?: boolean };
    expect(json.deduplicated).toBe(true);
  });

  it("acks 200 even when the ingest sink throws (Intercom would retry)", async () => {
    const ingest: StatewaveIngest = vi.fn(async () => {
      throw new Error("downstream down");
    });
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest,
      logger: () => undefined,
    });
    const body = JSON.stringify(
      buildEnvelope("conversation.user.created", buildConversation()),
    );
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
  });

  it("exposes the dedup cache for cross-handler sharing", () => {
    const dedupCache = new InMemoryIntercomDedupCache();
    const handler = createIntercomWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      dedupCache,
    });
    expect(handler.dedupCache).toBe(dedupCache);
  });
});
