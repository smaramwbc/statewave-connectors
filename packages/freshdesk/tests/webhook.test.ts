import { describe, it, expect, vi } from "vitest";
import {
  createFreshdeskWebhookHandler,
  InMemoryFreshdeskDedupCache,
  type StatewaveIngest,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "shh-freshdesk";

function buildSignedRequest(
  body: string,
  options: { secret?: string; header?: string } = {},
): Request {
  const headerName = options.header ?? "x-statewave-token";
  return new Request("http://localhost/freshdesk/events", {
    method: "POST",
    headers: {
      [headerName]: options.secret ?? SECRET,
      "content-type": "application/json",
    },
    body,
  });
}

const TICKET = {
  id: 4242,
  subject: "Login failure",
  description_text: "Users see a 500 on /login since the latest deploy.",
  status: 2,
  priority: 3,
  type: "Incident",
  tags: ["auth", "regression"],
  requester_id: 9001,
  company_id: 7,
  brand_id: 1,
  created_at: "2026-05-09T08:00:00.000Z",
  updated_at: "2026-05-09T08:00:00.000Z",
};

describe("createFreshdeskWebhookHandler — config", () => {
  it("rejects without signingSecret", () => {
    expect(() =>
      createFreshdeskWebhookHandler({
        // @ts-expect-error testing runtime guard
        signingSecret: undefined,
        ingest: vi.fn(),
      }),
    ).toThrow();
  });

  it("rejects without ingest sink AND statewaveUrl", () => {
    expect(() => createFreshdeskWebhookHandler({ signingSecret: SECRET })).toThrow();
  });
});

describe("createFreshdeskWebhookHandler — auth", () => {
  it("returns 401 on missing signing header", async () => {
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const req = new Request("http://localhost/freshdesk/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "ticket.created", ticket: TICKET }),
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 on wrong secret", async () => {
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body, { secret: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("accepts a custom signing header name", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      signingHeader: "x-fd-shared-secret",
      ingest,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(
      buildSignedRequest(body, { header: "x-fd-shared-secret" }),
    );
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("freshdesk.ticket.created");
  });
});

describe("createFreshdeskWebhookHandler — dispatch", () => {
  it("ingests a ticket.created event", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      subdomain: "acme",
      ingest,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("freshdesk.ticket.created");
    expect(captured?.subject).toBe("customer:7");
    expect(captured?.text).toContain("Login failure");
    expect(captured?.source.url).toBe("https://acme.freshdesk.com/a/tickets/4242");
  });

  it("ingests a ticket.resolved event", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify({
      event: "ticket.resolved",
      ticket: { ...TICKET, status: 4 },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("freshdesk.ticket.resolved");
  });

  it("routes ticket.updated by current status (resolved/closed → resolved)", async () => {
    const captured: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured.push(ep);
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    await handler(buildSignedRequest(JSON.stringify({
      event: "ticket.updated",
      ticket: { ...TICKET, status: 2, updated_at: "2026-05-09T09:00:00.000Z" },
    })));
    await handler(buildSignedRequest(JSON.stringify({
      event: "ticket.updated",
      ticket: { ...TICKET, status: 4, updated_at: "2026-05-09T10:00:00.000Z" },
    })));
    expect(captured.map((e) => e.kind)).toEqual([
      "freshdesk.ticket.created",
      "freshdesk.ticket.resolved",
    ]);
  });

  it("ingests a comment.added event (public reply)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify({
      event: "comment.added",
      ticket: TICKET,
      comment: {
        id: 1000,
        private: false,
        body_text: "Reproduced — investigating.",
        user_id: 9001,
        source: 1,
        created_at: "2026-05-09T08:30:00.000Z",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("freshdesk.conversation.posted");
    expect(captured?.text).toContain("Reproduced");
    expect(captured?.metadata?.private).toBe(false);
  });

  it("ingests a comment.added event (private internal note)", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify({
      event: "comment.added",
      ticket: TICKET,
      comment: {
        id: 1001,
        private: true,
        body_text: "Hand off to platform team.",
        user_id: 555,
        created_at: "2026-05-09T08:45:00.000Z",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("freshdesk.conversation.internal_note");
    expect(captured?.text).toContain("(internal note)");
  });

  it("ignores unknown event types with 200 + 'unknown_event'", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify({ event: "some.future.event", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("unknown_event");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("dedups retried deliveries by event_id", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    const body = JSON.stringify({
      event: "ticket.created",
      event_id: "fd_evt_123",
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
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
    });
    // Same ticket id + updated_at + event => synthesized id collides => dedup hits.
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    await handler(buildSignedRequest(body));
    await handler(buildSignedRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("rejects payloads missing ticket id with 200 + 'missing_ticket'", async () => {
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
    });
    const body = JSON.stringify({ event: "ticket.created" });
    const res = await handler(buildSignedRequest(body));
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("missing_ticket");
  });

  it("acks 200 even when the ingest sink throws (Freshdesk would retry)", async () => {
    const ingest: StatewaveIngest = vi.fn(async () => {
      throw new Error("downstream down");
    });
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest,
      logger: () => undefined,
    });
    const body = JSON.stringify({ event: "ticket.created", ticket: TICKET });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
  });

  it("exposes the dedup cache for cross-handler sharing", () => {
    const dedupCache = new InMemoryFreshdeskDedupCache();
    const handler = createFreshdeskWebhookHandler({
      signingSecret: SECRET,
      ingest: vi.fn(),
      dedupCache,
    });
    expect(handler.dedupCache).toBe(dedupCache);
  });
});
