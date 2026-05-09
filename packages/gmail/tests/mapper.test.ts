import { describe, it, expect } from "vitest";
import { classifyMessage, defaultSubject, mapGmailEvent } from "../src/index.js";
import type { GmailMessage } from "../src/index.js";

const received: GmailMessage = {
  id: "msg_in_1",
  thread_id: "thr_a",
  internal_date: "2026-05-09T08:00:00.000Z",
  label_ids: ["INBOX", "UNREAD"],
  snippet: "Quick question about the deploy",
  from: "Alice Doe <alice@acme.example>",
  to: "Statewave Team <team@statewave.ai>",
  subject: "Login regression",
  date: "Mon, 9 May 2026 08:00:00 +0000",
  message_id_header: "<msg_in_1@mail.acme.example>",
  body: "Users are seeing 500s on /login since the deploy. Can you check?",
};

const sent: GmailMessage = {
  id: "msg_out_1",
  thread_id: "thr_a",
  internal_date: "2026-05-09T08:30:00.000Z",
  label_ids: ["SENT"],
  snippet: "Reproduced — investigating",
  from: "Statewave Team <team@statewave.ai>",
  to: "Alice Doe <alice@acme.example>",
  subject: "Re: Login regression",
  date: "Mon, 9 May 2026 08:30:00 +0000",
  body: "Reproduced. Rolling back the deploy now.",
};

describe("gmail mapper", () => {
  it("classifies a message with the SENT label as sent", () => {
    expect(classifyMessage(sent).type).toBe("message.sent");
  });

  it("classifies a message without the SENT label as received", () => {
    expect(classifyMessage(received).type).toBe("message.received");
  });

  it("uses relationship:<from> as the default subject for received", () => {
    expect(defaultSubject(received, false)).toBe("relationship:alice@acme.example");
  });

  it("uses relationship:<to> as the default subject for sent", () => {
    expect(defaultSubject(sent, true)).toBe("relationship:alice@acme.example");
  });

  it("falls back to thread:<id> when no addresses are present", () => {
    const headerless: GmailMessage = { ...received, from: undefined, to: undefined };
    expect(defaultSubject(headerless, false)).toBe("thread:thr_a");
  });

  it("normalizes display-name addresses and lowercases", () => {
    const upper: GmailMessage = { ...received, from: '"Bob, Jr." <BOB@Acme.Example>' };
    expect(defaultSubject(upper, false)).toBe("relationship:bob@acme.example");
  });

  it("maps a received message to gmail.message.received with sender + body", () => {
    const ep = mapGmailEvent(classifyMessage(received));
    expect(ep.subject).toBe("relationship:alice@acme.example");
    expect(ep.kind).toBe("gmail.message.received");
    expect(ep.text).toContain("received email from alice@acme.example");
    expect(ep.text).toContain("Login regression");
    expect(ep.text).toContain("500s on /login");
    expect(ep.source.type).toBe("gmail.message.received");
    expect(ep.source.id).toBe("message:msg_in_1");
    expect(ep.source.url).toBe("https://mail.google.com/mail/u/0/#all/msg_in_1");
    expect(ep.metadata?.direction).toBe("received");
    expect(ep.metadata?.thread_id).toBe("thr_a");
  });

  it("maps a sent message to gmail.message.sent with recipient + body", () => {
    const ep = mapGmailEvent(classifyMessage(sent));
    expect(ep.subject).toBe("relationship:alice@acme.example");
    expect(ep.kind).toBe("gmail.message.sent");
    expect(ep.text).toContain("sent email to alice@acme.example");
    expect(ep.text).toContain("Re: Login regression");
    expect(ep.text).toContain("Rolling back the deploy");
    expect(ep.metadata?.direction).toBe("sent");
  });

  it("respects a caller-supplied subject override", () => {
    const ep = mapGmailEvent(classifyMessage(received), { subject: "thread:thr_a" });
    expect(ep.subject).toBe("thread:thr_a");
  });

  it("uses the Date header for occurred_at when parseable", () => {
    const ep = mapGmailEvent(classifyMessage(received));
    expect(ep.occurred_at).toBe("2026-05-09T08:00:00.000Z");
  });

  it("falls back to internal_date when the Date header is unparseable", () => {
    const bad: GmailMessage = { ...received, date: "not a date" };
    const ep = mapGmailEvent(classifyMessage(bad));
    expect(ep.occurred_at).toBe(received.internal_date);
  });

  it("renders an unsubject'd message with a fallback subject line", () => {
    const blank: GmailMessage = { ...received, subject: "" };
    const ep = mapGmailEvent(classifyMessage(blank));
    expect(ep.text).toContain("(no subject)");
  });
});
