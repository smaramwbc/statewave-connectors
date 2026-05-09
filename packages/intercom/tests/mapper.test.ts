import { describe, it, expect } from "vitest";
import { defaultSubject, mapIntercomEvent } from "../src/index.js";
import type {
  IntercomContact,
  IntercomConversation,
  IntercomConversationPart,
} from "../src/index.js";

const conversation: IntercomConversation = {
  id: "987",
  created_at: "2026-05-09T08:00:00.000Z",
  updated_at: "2026-05-09T09:30:00.000Z",
  state: "open",
  priority: "priority",
  tags: ["regression", "auth"],
  source_body: "Users see a 500 on /login since the latest deploy.",
  source_subject: "Login failure",
  contact: {
    id: "contact_123",
    primary_company_id: "company_7",
    primary_company_name: "Acme Industries",
  },
  assignee_admin_id: "admin_1",
  team_assignee_id: "team_2",
};

const contactDir: ReadonlyMap<string, IntercomContact> = new Map([
  [
    "contact_123",
    {
      id: "contact_123",
      name: "Ada Lovelace",
      email: "ada@acme.example",
      external_id: "ext_42",
      primary_company_id: "company_7",
      primary_company_name: "Acme Industries",
    },
  ],
]);

describe("intercom mapper", () => {
  it("subjects on customer:<primary_company_id> when set", () => {
    expect(defaultSubject(conversation, contactDir)).toBe("customer:company_7");
  });

  it("falls back to customer:<contact_id> when no primary company", () => {
    const c: IntercomConversation = {
      ...conversation,
      contact: { id: "contact_solo" },
    };
    expect(defaultSubject(c)).toBe("customer:contact_solo");
  });

  it("falls back to conversation:<id> when no contact at all", () => {
    const c: IntercomConversation = { ...conversation, contact: undefined };
    expect(defaultSubject(c)).toBe("conversation:987");
  });

  it("maps conversation.created with subject + body in the text", () => {
    const ep = mapIntercomEvent(
      { type: "conversation.created", conversation },
      { contactDirectory: contactDir, appId: "abc123", region: "us" },
    );
    expect(ep.subject).toBe("customer:company_7");
    expect(ep.kind).toBe("intercom.conversation.created");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("conversation #987");
    expect(ep.text).toContain("Login failure");
    expect(ep.text).toContain("Users see a 500");
    expect(ep.source.type).toBe("intercom.conversation");
    expect(ep.source.id).toBe("conversation:987");
    expect(ep.source.url).toBe(
      "https://app.intercom.com/a/inbox/abc123/inbox/conversation/987",
    );
    expect(ep.metadata?.conversation_state).toBe("open");
    expect(ep.metadata?.primary_company_name).toBe("Acme Industries");
    expect(ep.metadata?.contact_email).toBe("ada@acme.example");
  });

  it("uses regional permalinks for EU + AU workspaces", () => {
    const eu = mapIntercomEvent(
      { type: "conversation.created", conversation },
      { contactDirectory: contactDir, appId: "abc123", region: "eu" },
    );
    expect(eu.source.url).toBe(
      "https://app.eu.intercom.com/a/inbox/abc123/inbox/conversation/987",
    );
    const au = mapIntercomEvent(
      { type: "conversation.created", conversation },
      { contactDirectory: contactDir, appId: "abc123", region: "au" },
    );
    expect(au.source.url).toBe(
      "https://app.au.intercom.com/a/inbox/abc123/inbox/conversation/987",
    );
  });

  it("maps conversation.closed with the resolution source type", () => {
    const closed: IntercomConversation = {
      ...conversation,
      state: "closed",
      updated_at: "2026-05-09T11:00:00.000Z",
    };
    const ep = mapIntercomEvent(
      { type: "conversation.closed", conversation: closed },
      { contactDirectory: contactDir, appId: "abc123" },
    );
    expect(ep.kind).toBe("intercom.conversation.closed");
    expect(ep.source.type).toBe("intercom.conversation.resolution");
    expect(ep.occurred_at).toBe("2026-05-09T11:00:00.000Z");
    expect(ep.text).toContain("closed");
  });

  it("maps a public reply to intercom.conversation.replied", () => {
    const part: IntercomConversationPart = {
      id: "part_500",
      part_type: "comment",
      body: "Reproduced — investigating.",
      created_at: "2026-05-09T08:30:00.000Z",
      author_type: "admin",
      author_id: "admin_1",
      author_name: "Grace Hopper",
    };
    const ep = mapIntercomEvent(
      { type: "conversation.part", conversation, part },
      { contactDirectory: contactDir, appId: "abc123" },
    );
    expect(ep.kind).toBe("intercom.conversation.replied");
    expect(ep.source.type).toBe("intercom.reply");
    expect(ep.source.id).toBe("conversation:987:part:part_500");
    expect(ep.text).toContain("Grace Hopper");
    expect(ep.text).not.toContain("internal note");
    expect(ep.text).toContain("Reproduced");
    expect(ep.metadata?.is_internal_note).toBe(false);
    expect(ep.metadata?.author_type).toBe("admin");
  });

  it("maps an admin note to intercom.conversation.note_added", () => {
    const part: IntercomConversationPart = {
      id: "part_501",
      part_type: "note",
      body: "Hand off to platform team — auth deploy regression.",
      created_at: "2026-05-09T08:45:00.000Z",
      author_type: "admin",
      author_id: "admin_2",
      author_name: "Hopper, G.",
    };
    const ep = mapIntercomEvent({ type: "conversation.part", conversation, part });
    expect(ep.kind).toBe("intercom.conversation.note_added");
    expect(ep.source.type).toBe("intercom.note");
    expect(ep.text).toContain("(internal note)");
    expect(ep.metadata?.is_internal_note).toBe(true);
  });

  it("respects a caller-supplied subject override", () => {
    const ep = mapIntercomEvent(
      { type: "conversation.created", conversation },
      { subject: "account:acme" },
    );
    expect(ep.subject).toBe("account:acme");
  });

  it("uses the directory contact name over the conversation contact stub", () => {
    const stub: IntercomConversation = {
      ...conversation,
      contact: { id: "contact_123" }, // no name on the stub
    };
    const ep = mapIntercomEvent(
      { type: "conversation.created", conversation: stub },
      { contactDirectory: contactDir, appId: "abc123" },
    );
    expect(ep.text).toContain("Ada Lovelace");
  });
});
