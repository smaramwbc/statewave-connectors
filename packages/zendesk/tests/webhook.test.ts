import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  createZendeskWebhookHandler,
  InMemoryZendeskDedupCache,
  type StatewaveIngest,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "shh-zendesk";
const NOW_SEC = 1_700_000_000;

function sign(body: string, timestamp: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(timestamp + body).digest("base64");
}

function buildSignedRequest(
  body: string,
  options: { timestamp?: string; secret?: string; signature?: string; missing?: "signature" | "timestamp" } = {},
): Request {
  const timestamp = options.timestamp ?? String(NOW_SEC);
  const signature = options.signature ?? sign(body, timestamp, options.secret ?? SECRET);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.missing !== "signature") headers["x-zendesk-webhook-signature"] = signature;
  if (options.missing !== "timestamp") headers["x-zendesk-webhook-signature-timestamp"] = timestamp;
  return new Request("http://localhost/zendesk/events", {
    method: "POST",
    headers,
    body,
  });
}

const TICKET = {
  id: 4242,
  subject: "Login failure",
  description: "Users see a 500 on /login since the latest deploy.",
  status: "open",
  priority: "high",
  type: "incident",
  tags: ["auth", "regression"],
  requester_id: 9001,
  organization_id: 7,
  brand_id: 1,
  created_at: "2026-05-09T08:00:00.000Z",
  updated_at: "2026-05-09T08:00:00.000Z",
};

describe("createZendeskWebhookHandler — config", () => {
  it("rejects without signingSecret", () => {
    expect(() =>
      createZendeskWebhookHandler({
        // @ts-expect-error testing runtime guard
        signingSecret: undefined,
        ingest: vi.fn(),
      }),
    ).toThrow();
  });

  it("rejects without ingest sink AND statewaveUrl", () => {
    expect(() => createZendeskWebhookHandler({ signingSecret: SECRET })).toThrow();
  });
});

describe("createZendeskWebhookHandler — auth", () => {
  it("returns 401 when signature header is missing", async () => {
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body, { missing: "signature" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when timestamp header is missing", async () => {
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body, { missing: "timestamp" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 on bad signature", async () => {
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(
      buildSignedRequest(body, { signature: "totally-not-the-right-mac" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on stale timestamp (outside replay window)", async () => {
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      now: () => NOW_SEC,
      replayWindowSec: 60,
    });
    const stale = String(NOW_SEC - 600);
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body, { timestamp: stale }));
    expect(res.status).toBe(401);
  });

  it("accepts a custom signature header name", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      signatureHeader: "x-zd-mac",
      timestampHeader: "x-zd-mac-ts",
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const timestamp = String(NOW_SEC);
    const signature = sign(body, timestamp);
    const req = new Request("http://localhost/zendesk/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zd-mac": signature,
        "x-zd-mac-ts": timestamp,
      },
      body,
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("zendesk.ticket.created");
  });
});

describe("createZendeskWebhookHandler — trigger-driven dispatch", () => {
  it("ingests a ticket.created event", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      subdomain: "acme",
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("zendesk.ticket.created");
    expect(captured?.subject).toBe("customer:7");
    expect(captured?.text).toContain("Login failure");
    expect(captured?.source.url).toBe("https://acme.zendesk.com/agent/tickets/4242");
  });

  it("ingests a ticket.solved event", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      event: "ticket.solved",
      ticket: { ...TICKET, status: "solved" },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.ticket.solved");
  });

  it("routes ticket.updated by current status (solved/closed → solved)", async () => {
    const captured: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured.push(ep);
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    await handler(
      buildSignedRequest(
        JSON.stringify({
          event: "ticket.updated",
          ticket: { ...TICKET, status: "open", updated_at: "2026-05-09T09:00:00.000Z" },
        }),
      ),
    );
    await handler(
      buildSignedRequest(
        JSON.stringify({
          event: "ticket.updated",
          ticket: { ...TICKET, status: "solved", updated_at: "2026-05-09T10:00:00.000Z" },
        }),
      ),
    );
    expect(captured.map((e) => e.kind)).toEqual([
      "zendesk.ticket.created",
      "zendesk.ticket.solved",
    ]);
  });

  it("ingests a comment.created event (public reply)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      event: "comment.created",
      ticket: TICKET,
      comment: {
        id: 1000,
        public: true,
        body: "Reproduced — investigating.",
        author_id: 9001,
        created_at: "2026-05-09T08:30:00.000Z",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.comment.posted");
    expect(captured?.text).toContain("Reproduced");
    expect(captured?.metadata?.public).toBe(true);
  });

  it("ingests a comment.created event (private internal note)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      event: "comment.created",
      ticket: TICKET,
      comment: {
        id: 1001,
        public: false,
        body: "Hand off to platform team.",
        author_id: 555,
        created_at: "2026-05-09T08:45:00.000Z",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.comment.internal_note");
    expect(captured?.text).toContain("(internal note)");
  });
});

describe("createZendeskWebhookHandler — event-driven dispatch", () => {
  it("ingests zen:event-type:ticket.created", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      subdomain: "acme",
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      id: "evt_abc123",
      type: "zen:event-type:ticket.created",
      time: "2026-05-09T08:00:00Z",
      event: { ticket: TICKET },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.ticket.created");
    expect(captured?.subject).toBe("customer:7");
  });

  it("ingests zen:event-type:comment.created (public)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      id: "evt_comment1",
      type: "zen:event-type:comment.created",
      event: {
        ticket: TICKET,
        comment: {
          id: 2000,
          public: true,
          body: "Pushing a hotfix.",
          author_id: 555,
          created_at: "2026-05-09T08:30:00.000Z",
        },
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.comment.posted");
  });

  it("routes ticket.status_changed via the updated codepath", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      id: "evt_status1",
      type: "zen:event-type:ticket.status_changed",
      event: { ticket: { ...TICKET, status: "closed" } },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("zendesk.ticket.solved");
  });
});

describe("createZendeskWebhookHandler — tolerance & dedup", () => {
  it("ignores unknown event types with 200 + 'unknown_event'", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "some.future.event", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("unknown_event");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("rejects payloads missing ticket id with 200 + 'missing_ticket'", async () => {
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created" });
    const res = await handler(buildSignedRequest(body));
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("missing_ticket");
  });

  it("dedups retried deliveries by event_id", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      event: "ticket.created",
      event_id: "zd_evt_123",
      ticket: TICKET,
    });
    await handler(buildSignedRequest(body));
    const res2 = await handler(buildSignedRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
    const json = (await res2.json()) as { deduplicated?: boolean };
    expect(json.deduplicated).toBe(true);
  });

  it("synthesizes event_id from ticket id + updated_at when payload doesn't include one", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    await handler(buildSignedRequest(body));
    await handler(buildSignedRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("dedups event-driven deliveries by Zendesk's stable id", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({
      id: "evt_stable_1",
      type: "zen:event-type:ticket.created",
      event: { ticket: TICKET },
    });
    await handler(buildSignedRequest(body));
    await handler(buildSignedRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("acks 200 even when the ingest sink throws (Zendesk would retry)", async () => {
    const ingest: StatewaveIngest = vi.fn(async () => {
      throw new Error("downstream down");
    });
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      logger: () => undefined,
      now: () => NOW_SEC,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
  });

  it("exposes the dedup cache for cross-handler sharing", () => {
    const dedupCache = new InMemoryZendeskDedupCache();
    const handler = createZendeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      dedupCache,
      now: () => NOW_SEC,
    });
    expect(handler.dedupCache).toBe(dedupCache);
  });
});
