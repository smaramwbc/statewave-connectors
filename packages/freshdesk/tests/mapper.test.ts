import { describe, it, expect } from "vitest";
import { defaultSubject, mapFreshdeskEvent } from "../src/index.js";
import type {
  FreshdeskConversation,
  FreshdeskTicket,
  FreshdeskUser,
} from "../src/index.js";

const ticket: FreshdeskTicket = {
  id: 4242,
  subject: "Login failure",
  description_text: "Users see a 500 on /login since the latest deploy.",
  status: "open",
  status_code: 2,
  priority: 3,
  type: "Incident",
  tags: ["regression", "auth"],
  requester_id: 9001,
  responder_id: 12,
  company_id: 7,
  group_id: 2,
  product_id: 3,
  created_at: "2026-05-09T08:00:00.000Z",
  updated_at: "2026-05-09T09:30:00.000Z",
};

const requester: FreshdeskUser = {
  id: 9001,
  name: "Ada Lovelace",
  email: "ada@acme.example",
  company_id: 7,
};

const company = { id: 7, name: "Acme Industries" };

describe("freshdesk mapper", () => {
  it("subjects on customer:<company_id> when set", () => {
    expect(defaultSubject(ticket)).toBe("customer:7");
  });

  it("falls back to customer:<requester_id> when no company", () => {
    expect(defaultSubject({ ...ticket, company_id: null })).toBe("customer:9001");
  });

  it("falls back to ticket:<id> when neither company nor requester", () => {
    expect(defaultSubject({ ...ticket, company_id: null, requester_id: null })).toBe(
      "ticket:4242",
    );
  });

  it("maps ticket.created with subject + description in the text", () => {
    const ep = mapFreshdeskEvent(
      { type: "ticket.created", ticket, requester, company },
      { subdomain: "acme" },
    );
    expect(ep.subject).toBe("customer:7");
    expect(ep.kind).toBe("freshdesk.ticket.created");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("ticket #4242");
    expect(ep.text).toContain("Login failure");
    expect(ep.text).toContain("Users see a 500");
    expect(ep.source.type).toBe("freshdesk.ticket");
    expect(ep.source.id).toBe("ticket:4242");
    expect(ep.source.url).toBe("https://acme.freshdesk.com/a/tickets/4242");
    expect(ep.metadata?.ticket_status).toBe("open");
    expect(ep.metadata?.ticket_status_code).toBe(2);
    expect(ep.metadata?.company_name).toBe("Acme Industries");
    expect(ep.metadata?.requester_email).toBe("ada@acme.example");
  });

  it("maps ticket.resolved with the resolution source type", () => {
    const ep = mapFreshdeskEvent(
      {
        type: "ticket.resolved",
        ticket: { ...ticket, status: "resolved", updated_at: "2026-05-09T11:00:00.000Z" },
        requester,
        company,
      },
      { subdomain: "acme" },
    );
    expect(ep.kind).toBe("freshdesk.ticket.resolved");
    expect(ep.source.type).toBe("freshdesk.ticket.resolution");
    expect(ep.occurred_at).toBe("2026-05-09T11:00:00.000Z");
    expect(ep.text).toContain("resolved");
  });

  it("uses 'closed' verb for closed tickets", () => {
    const ep = mapFreshdeskEvent({
      type: "ticket.resolved",
      ticket: { ...ticket, status: "closed" },
    });
    expect(ep.text).toContain("closed");
  });

  it("maps a public reply to freshdesk.conversation.posted", () => {
    const conversation: FreshdeskConversation = {
      id: 100,
      ticket_id: ticket.id,
      private: false,
      body_text: "Reproduced — investigating.",
      user_id: 9001,
      incoming: true,
      source: 1, // email
      created_at: "2026-05-09T08:30:00.000Z",
    };
    const ep = mapFreshdeskEvent(
      { type: "conversation", ticket, conversation, requester, company },
      { subdomain: "acme" },
    );
    expect(ep.kind).toBe("freshdesk.conversation.posted");
    expect(ep.source.type).toBe("freshdesk.conversation");
    expect(ep.source.id).toBe("ticket:4242:conversation:100");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("via email");
    expect(ep.text).not.toContain("internal note");
    expect(ep.text).toContain("Reproduced");
    expect(ep.metadata?.via_channel).toBe("email");
    expect(ep.metadata?.private).toBe(false);
    expect(ep.metadata?.incoming).toBe(true);
  });

  it("maps an internal note to freshdesk.conversation.internal_note", () => {
    const conversation: FreshdeskConversation = {
      id: 101,
      ticket_id: ticket.id,
      private: true,
      body_text: "Hand off to platform team — auth deploy regression.",
      user_id: 555,
      created_at: "2026-05-09T08:45:00.000Z",
    };
    const ep = mapFreshdeskEvent({ type: "conversation", ticket, conversation });
    expect(ep.kind).toBe("freshdesk.conversation.internal_note");
    expect(ep.source.type).toBe("freshdesk.internal_note");
    expect(ep.text).toContain("(internal note)");
    expect(ep.metadata?.private).toBe(true);
  });

  it("renders unknown source codes as source:<n>", () => {
    const conversation: FreshdeskConversation = {
      id: 102,
      ticket_id: ticket.id,
      private: false,
      body_text: "Hi",
      user_id: 9001,
      source: 99, // not in the documented table
      created_at: "2026-05-09T09:00:00.000Z",
    };
    const ep = mapFreshdeskEvent(
      { type: "conversation", ticket, conversation, requester },
    );
    expect(ep.text).toContain("via source:99");
    expect(ep.metadata?.via_channel).toBe("source:99");
  });

  it("respects a caller-supplied subject override", () => {
    const ep = mapFreshdeskEvent(
      { type: "ticket.created", ticket },
      { subject: "account:acme" },
    );
    expect(ep.subject).toBe("account:acme");
  });

  it("emits no permalink when subdomain is omitted", () => {
    const ep = mapFreshdeskEvent({ type: "ticket.created", ticket });
    expect(ep.source.url).toBeUndefined();
  });
});
