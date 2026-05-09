import { describe, it, expect } from "vitest";
import { defaultSubject, mapDiscordEvent } from "../src/index.js";
import type { DiscordGuild, DiscordMessage } from "../src/index.js";

const guild: DiscordGuild = { id: "G01ABC", name: "Acme Community" };
const textChannel = { id: "C01XYZ", name: "general", type: 0 };
const threadChannel = { id: "T01ABC", name: "release-q1", type: 11, parent_id: "C01XYZ" };

function topLevel(text: string, id = "1100000000000000000"): DiscordMessage {
  return {
    type: "message",
    id,
    channel: textChannel,
    guild,
    author: { id: "U01ADA", username: "ada", global_name: "Ada Lovelace" },
    content: text,
    timestamp: "2026-05-09T10:00:00.000Z",
  };
}

describe("discord mapper", () => {
  it("uses community:<guild_id> as the default subject", () => {
    expect(defaultSubject(guild)).toBe("community:G01ABC");
  });

  it("maps a top-level message to discord.message.posted", () => {
    const ep = mapDiscordEvent(topLevel("hello world"));
    expect(ep.subject).toBe("community:G01ABC");
    expect(ep.kind).toBe("discord.message.posted");
    expect(ep.text).toContain("Ada Lovelace");
    expect(ep.text).toContain("#general");
    expect(ep.text).toContain("hello world");
    expect(ep.source.type).toBe("discord.message");
    expect(ep.source.id).toBe("C01XYZ:1100000000000000000");
    expect(ep.source.url).toBe(
      "https://discord.com/channels/G01ABC/C01XYZ/1100000000000000000",
    );
    expect(ep.metadata?.guild_id).toBe("G01ABC");
    expect(ep.metadata?.channel_name).toBe("general");
  });

  it("maps a thread reply to discord.thread.replied", () => {
    const m: DiscordMessage = {
      ...topLevel("thread reply"),
      id: "1100000000000000001",
      channel: threadChannel,
    };
    const ep = mapDiscordEvent(m);
    expect(ep.kind).toBe("discord.thread.replied");
    expect(ep.source.type).toBe("discord.thread.reply");
    expect(ep.metadata?.parent_id).toBe("C01XYZ");
  });

  it("respects a caller-supplied subject", () => {
    const ep = mapDiscordEvent(topLevel("hi"), { subject: "topic:design" });
    expect(ep.subject).toBe("topic:design");
  });

  it("falls back to username, then to <@id> when no display name is set", () => {
    const m: DiscordMessage = {
      ...topLevel("hi"),
      author: { id: "U01BOB", username: "bob" },
    };
    const ep = mapDiscordEvent(m);
    expect(ep.text).toContain("bob");

    const m2: DiscordMessage = { ...topLevel("hi"), author: { id: "U01CAT" } };
    const ep2 = mapDiscordEvent(m2);
    expect(ep2.text).toContain("<@U01CAT>");
  });

  it("uses the message timestamp for occurred_at", () => {
    const ep = mapDiscordEvent(topLevel("ping"));
    expect(ep.occurred_at).toBe("2026-05-09T10:00:00.000Z");
  });

  it("produces deterministic idempotency keys for the same message", () => {
    const a = mapDiscordEvent(topLevel("hi"));
    const b = mapDiscordEvent(topLevel("hi"));
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it("treats announcement-thread (type 10) and private-thread (12) as thread replies too", () => {
    for (const type of [10, 12]) {
      const m: DiscordMessage = {
        ...topLevel("hi"),
        channel: { id: "T0X", name: "x", type, parent_id: "C01XYZ" },
      };
      expect(mapDiscordEvent(m).kind).toBe("discord.thread.replied");
    }
  });
});
