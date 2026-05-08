import { describe, it, expect } from "vitest";
import { defaultSubject, mapSlackEvent } from "../src/index.js";
import type { SlackMessage, SlackUser, SlackWorkspace } from "../src/index.js";

const workspace: SlackWorkspace = { team_id: "T01ABCD", team_name: "Acme" };
const channel = { id: "C01XYZ", name: "general" } as const;

function topLevel(text: string, ts = "1700000000.000100"): SlackMessage {
  return {
    type: "message",
    ts,
    thread_ts: ts,
    channel,
    user: { id: "U01ADA" },
    text,
  };
}

describe("slack mapper", () => {
  it("uses team:<team_id> as the default subject", () => {
    expect(defaultSubject(workspace)).toBe("team:T01ABCD");
  });

  it("maps a top-level message to slack.message.posted", () => {
    const ep = mapSlackEvent(topLevel("hello world"), { workspace });
    expect(ep.subject).toBe("team:T01ABCD");
    expect(ep.kind).toBe("slack.message.posted");
    expect(ep.text).toContain("#general");
    expect(ep.text).toContain("hello world");
    expect(ep.source.type).toBe("slack.message");
    expect(ep.source.id).toBe("C01XYZ:1700000000.000100");
    expect(ep.metadata?.workspace_id).toBe("T01ABCD");
    expect(ep.metadata?.channel_name).toBe("general");
  });

  it("maps a thread reply to slack.thread.replied", () => {
    const reply: SlackMessage = {
      type: "message",
      ts: "1700000050.000200",
      thread_ts: "1700000000.000100",
      channel,
      user: { id: "U01BOB" },
      text: "thread reply",
    };
    const ep = mapSlackEvent(reply, { workspace });
    expect(ep.kind).toBe("slack.thread.replied");
    expect(ep.source.type).toBe("slack.thread.reply");
    expect(ep.metadata?.thread_ts).toBe("1700000000.000100");
  });

  it("respects a caller-supplied subject", () => {
    const ep = mapSlackEvent(topLevel("hi"), {
      workspace,
      subject: "customer:acme",
    });
    expect(ep.subject).toBe("customer:acme");
  });

  it("expands <@Uxxx> mentions when a user directory is provided", () => {
    const directory = new Map<string, SlackUser>([
      ["U01ADA", { id: "U01ADA", real_name: "Ada Lovelace" }],
      ["U01BOB", { id: "U01BOB", name: "bob" }],
    ]);
    const m = topLevel("hey <@U01BOB> can you look at this?");
    const ep = mapSlackEvent(m, { workspace, userDirectory: directory });
    expect(ep.text).toContain("@bob");
    expect(ep.text).toContain("Ada Lovelace");
  });

  it("leaves <@Uxxx> mentions intact when no directory is provided", () => {
    const ep = mapSlackEvent(topLevel("hey <@U01BOB>"), { workspace });
    expect(ep.text).toContain("<@U01BOB>");
  });

  it("falls back to bot:<id> when there is no user", () => {
    const m: SlackMessage = {
      ...topLevel("automated message"),
      user: null,
      bot_id: "B01ROBOT",
    };
    const ep = mapSlackEvent(m, { workspace });
    expect(ep.text).toContain("bot:B01ROBOT");
    expect(ep.metadata?.bot_id).toBe("B01ROBOT");
  });

  it("produces deterministic idempotency keys", () => {
    const a = mapSlackEvent(topLevel("hi"), { workspace });
    const b = mapSlackEvent(topLevel("hi"), { workspace });
    expect(a.idempotency_key).toEqual(b.idempotency_key);
  });

  it("converts Slack ts to ISO-8601 in occurred_at", () => {
    const ep = mapSlackEvent(topLevel("ping", "1700000000.000000"), { workspace });
    // 1700000000 unix-seconds = 2023-11-14T22:13:20.000Z
    expect(ep.occurred_at).toBe("2023-11-14T22:13:20.000Z");
  });
});
