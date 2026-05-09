import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createDiscordConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: unknown;
  status?: number;
}

/** Route by exact path suffix for predictable matching. */
function fakeFetch(handlers: Record<string, FakeResponseSpec>): typeof fetch {
  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [pattern, spec] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        return new Response(JSON.stringify(spec.body), {
          status: spec.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "no_handler", url: u }), { status: 404 });
  }) as typeof fetch;
}

describe("createDiscordConnector", () => {
  it("requires a guildId", () => {
    expect(() =>
      createDiscordConnector({
        token: "xxx",
        // @ts-expect-error testing the runtime guard
        guildId: undefined,
        channels: ["general"],
      }),
    ).toThrow(ConnectorError);
  });

  it("requires at least one channel", () => {
    expect(() =>
      createDiscordConnector({
        token: "xxx",
        guildId: "G01ABC",
        channels: [],
      }),
    ).toThrow(ConnectorError);
  });

  it("requires a token", () => {
    expect(() =>
      createDiscordConnector({
        token: "",
        guildId: "G01ABC",
        channels: ["general"],
      }),
    ).toThrow(ConnectorError);
  });

  it("syncs channel messages and reverses to chronological order", async () => {
    const fetchImpl = fakeFetch({
      "/users/@me": { body: { id: "B01BOT", username: "statewave-bot" } },
      "/guilds/G01ABC/channels": {
        body: [
          { id: "C01XYZ", name: "general", type: 0 },
          { id: "C02ABC", name: "support", type: 0 },
        ],
      },
      "/guilds/G01ABC": { body: { id: "G01ABC", name: "Acme" } },
      "/channels/C01XYZ/messages": {
        // Discord returns newest-first; the connector reverses to
        // chronological order in the result.
        body: [
          {
            id: "1100000000000000002",
            type: 0,
            channel_id: "C01XYZ",
            author: { id: "U01BOB", username: "bob" },
            content: "second",
            timestamp: "2026-05-09T10:01:00.000Z",
          },
          {
            id: "1100000000000000001",
            type: 0,
            channel_id: "C01XYZ",
            author: { id: "U01ADA", username: "ada" },
            content: "first",
            timestamp: "2026-05-09T10:00:00.000Z",
          },
        ],
      },
    });

    const connector = createDiscordConnector({
      token: "xxx",
      guildId: "G01ABC",
      channels: ["general"],
      fetchImpl,
    });

    const result = await connector.sync({ dryRun: true });
    expect(result.connector).toBe("discord");
    expect(result.subject).toBe("community:G01ABC");
    expect(result.episodes.length).toBe(2);
    // Chronological order: oldest first.
    expect(result.episodes[0]!.text).toContain("first");
    expect(result.episodes[1]!.text).toContain("second");
    expect(result.summary.details?.events_messages).toBe(2);
    expect(result.summary.details?.channels_synced).toBe(1);
  });

  it("respects --max-items by capping mapped episodes", async () => {
    const fetchImpl = fakeFetch({
      "/users/@me": { body: { id: "B01BOT" } },
      "/guilds/G01ABC/channels": {
        body: [{ id: "C01XYZ", name: "general", type: 0 }],
      },
      "/guilds/G01ABC": { body: { id: "G01ABC" } },
      "/channels/C01XYZ/messages": {
        body: Array.from({ length: 5 }, (_, i) => ({
          id: `110000000000000000${5 - i}`,
          type: 0,
          channel_id: "C01XYZ",
          author: { id: "U01ADA", username: "ada" },
          content: `m${5 - i}`,
          timestamp: `2026-05-09T10:0${5 - i}:00.000Z`,
        })),
      },
    });
    const connector = createDiscordConnector({
      token: "xxx",
      guildId: "G01ABC",
      channels: ["general"],
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true, maxItems: 2 });
    // Discord client honors maxItems during pagination (stops paging
    // early), so only 2 messages are fetched + mapped — `skipped` is 0
    // because nothing was dropped at the slice step.
    expect(result.episodes.length).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("drops empty-content + system messages", async () => {
    const fetchImpl = fakeFetch({
      "/users/@me": { body: { id: "B01BOT" } },
      "/guilds/G01ABC/channels": {
        body: [{ id: "C01XYZ", name: "general", type: 0 }],
      },
      "/guilds/G01ABC": { body: { id: "G01ABC" } },
      "/channels/C01XYZ/messages": {
        body: [
          // Real message
          {
            id: "1100000000000000010",
            type: 0,
            channel_id: "C01XYZ",
            author: { id: "U01ADA", username: "ada" },
            content: "real content",
            timestamp: "2026-05-09T10:00:00.000Z",
          },
          // Empty content (embed-only)
          {
            id: "1100000000000000011",
            type: 0,
            channel_id: "C01XYZ",
            author: { id: "U01BOB", username: "bob" },
            content: "",
            timestamp: "2026-05-09T10:01:00.000Z",
          },
          // System message (member join, type 7)
          {
            id: "1100000000000000012",
            type: 7,
            channel_id: "C01XYZ",
            author: { id: "U01CAT", username: "cat" },
            content: "joined the server",
            timestamp: "2026-05-09T10:02:00.000Z",
          },
        ],
      },
    });
    const connector = createDiscordConnector({
      token: "xxx",
      guildId: "G01ABC",
      channels: ["general"],
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes.length).toBe(1);
    expect(result.episodes[0]!.text).toContain("real content");
  });

  it("errors loudly when a named channel is not in the guild", async () => {
    const fetchImpl = fakeFetch({
      "/users/@me": { body: { id: "B01BOT" } },
      "/guilds/G01ABC/channels": {
        body: [{ id: "C01XYZ", name: "general", type: 0 }],
      },
      "/guilds/G01ABC": { body: { id: "G01ABC" } },
    });
    const connector = createDiscordConnector({
      token: "xxx",
      guildId: "G01ABC",
      channels: ["nope-not-a-channel"],
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toMatchObject({
      message: expect.stringContaining("channels not found"),
    });
  });

  it("surfaces 401 as auth_failed in check()", async () => {
    const fetchImpl = fakeFetch({
      "/users/@me": { body: { error: "Unauthorized" }, status: 401 },
    });
    const connector = createDiscordConnector({
      token: "bad",
      guildId: "G01ABC",
      channels: ["general"],
      fetchImpl,
    });
    const check = await connector.check();
    expect(check.status).toBe("error");
    expect(check.details[0].name).toBe("auth");
  });
});
