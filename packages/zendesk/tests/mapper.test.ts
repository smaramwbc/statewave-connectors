import { describe, it, expect } from "vitest";
import { defaultSubject, mapZendeskEvent } from "../src/index.js";
import type { ZendeskComment, ZendeskTicket, ZendeskUser } from "../src/index.js";

const ticket: ZendeskTicket = {
  id: 4242,
  subject: "Login failure",
  description: "Users see a 500 on /login since the latest deploy.",
  status: "open",
  priority: "high",
  type: "incident",
  tags: ["regression", "auth"],
  requester_id: 9001,
  organization_id: 7,
  brand_id: 1,
  group_id: 2,
  created_at: "2026-05-09T08:00:00.000Z",
  updated_at: "2026-05-09T09:30:00.000Z",
};

const requester: ZendeskUser = {
  id: 9001,
  name: "Ada Lovelace",
  email: "ada@acme.example",
  organization_id: 7,
};

const organization = { id: 7, name: "Acme Industries" };

describe("zendesk mapper", () => {
  it("subjects on customer:<organization_id> when org is set", () => {
    expect(defaultSubject(ticket)).toBe("customer:7");
  });

  it("falls back to customer:<requester_id> when no org", () => {
    expect(defaultSubject({ ...ticket, organization_id: null })).toBe("customer:9001");
  });

  it("falls back to ticket:<id> when neither org nor requester is present", () => {
    expect(
      defaultSubject({ ...ticket, organization_id: null, requester_id: undefined }),
    ).toBe("ticket:4242");
  });

  it("maps ticket.created with subject + description in the text", () => {
    const ep = mapZendeskEvent(
      { type: "ticket.created", ticket, requester, organization },
      { subdomain: "acme" },
    );
    expect(ep.subject).toBe("customer:7");
    expect(ep.kind).toBe("zendesk.ticket.created");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("ticket #4242");
    expect(ep.text).toContain("Login failure");
    expect(ep.text).toContain("Users see a 500");
    expect(ep.source.type).toBe("zendesk.ticket");
    expect(ep.source.id).toBe("ticket:4242");
    expect(ep.source.url).toBe("https://acme.zendesk.com/agent/tickets/4242");
    expect(ep.metadata?.ticket_status).toBe("open");
    expect(ep.metadata?.organization_name).toBe("Acme Industries");
    expect(ep.metadata?.requester_email).toBe("ada@acme.example");
  });

  it("maps ticket.solved with the resolution source type", () => {
    const ep = mapZendeskEvent(
      {
        type: "ticket.solved",
        ticket: { ...ticket, status: "solved", updated_at: "2026-05-09T11:00:00.000Z" },
        requester,
        organization,
      },
      { subdomain: "acme" },
    );
    expect(ep.kind).toBe("zendesk.ticket.solved");
    expect(ep.source.type).toBe("zendesk.ticket.resolution");
    expect(ep.occurred_at).toBe("2026-05-09T11:00:00.000Z");
    expect(ep.text).toContain("marked solved");
  });

  it("uses 'closed' verb for closed tickets", () => {
    const ep = mapZendeskEvent({
      type: "ticket.solved",
      ticket: { ...ticket, status: "closed" },
    });
    expect(ep.text).toContain("closed");
  });

  it("maps a public comment to zendesk.comment.posted", () => {
    const comment: ZendeskComment = {
      id: 100,
      ticket_id: ticket.id,
      public: true,
      body: "Reproduced — investigating.",
      author_id: 9001,
      created_at: "2026-05-09T08:30:00.000Z",
      via: { channel: "web" },
    };
    const ep = mapZendeskEvent(
      { type: "comment", ticket, comment, requester, organization },
      { subdomain: "acme" },
    );
    expect(ep.kind).toBe("zendesk.comment.posted");
    expect(ep.source.type).toBe("zendesk.comment");
    expect(ep.source.id).toBe("ticket:4242:comment:100");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("via web");
    expect(ep.text).not.toContain("internal note");
    expect(ep.text).toContain("Reproduced");
    expect(ep.metadata?.via_channel).toBe("web");
    expect(ep.metadata?.public).toBe(true);
  });

  it("maps an internal note to zendesk.comment.internal_note", () => {
    const comment: ZendeskComment = {
      id: 101,
      ticket_id: ticket.id,
      public: false,
      body: "Hand off to platform team — auth deploy regression.",
      author_id: 555,
      created_at: "2026-05-09T08:45:00.000Z",
    };
    const ep = mapZendeskEvent({ type: "comment", ticket, comment });
    expect(ep.kind).toBe("zendesk.comment.internal_note");
    expect(ep.source.type).toBe("zendesk.internal_note");
    expect(ep.text).toContain("(internal note)");
    expect(ep.metadata?.public).toBe(false);
  });

  it("respects a caller-supplied subject override", () => {
    const ep = mapZendeskEvent(
      { type: "ticket.created", ticket },
      { subject: "account:acme" },
    );
    expect(ep.subject).toBe("account:acme");
  });

  it("uses the API ticket url when no subdomain is provided", () => {
    const t = { ...ticket, url: "https://acme.zendesk.com/api/v2/tickets/4242.json" };
    const ep = mapZendeskEvent({ type: "ticket.created", ticket: t });
    expect(ep.source.url).toBe("https://acme.zendesk.com/api/v2/tickets/4242.json");
  });
});
