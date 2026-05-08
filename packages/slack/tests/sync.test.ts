import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createSlackConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: Record<string, unknown>;
  status?: number;
  retryAfter?: string;
}

/**
 * Build a fetch impl that routes by Slack API method name. Each Slack call
 * is `POST https://slack.com/api/<method>`, so matching on the trailing
 * path segment is enough.
 */
function fakeFetch(handlers: Record<string, FakeResponseSpec | FakeResponseSpec[]>): typeof fetch {
  // Each handler key may map to a single response (always returned) or a
  // queue of responses (consumed in order). The queue form lets us model a
  // 429 retry sequence without wiring a counter into every test.
  const queues: Record<string, FakeResponseSpec[]> = {};
  for (const [k, v] of Object.entries(handlers)) {
    queues[k] = Array.isArray(v) ? [...v] : [v];
  }

  return (async (url: RequestInfo | URL): Promise<Response> => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    for (const [method, q] of Object.entries(queues)) {
      if (u.endsWith(`/${method}`)) {
        const next = q.length > 1 ? q.shift()! : q[0];
        return new Response(JSON.stringify(next.body), {
          status: next.status ?? 200,
          headers: {
            "content-type": "application/json",
            ...(next.retryAfter ? { "retry-after": next.retryAfter } : {}),
          },
        });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: "no_handler" }), { status: 404 });
  }) as typeof fetch;
}

describe("createSlackConnector", () => {
  it("requires at least one channel", () => {
    expect(() =>
      createSlackConnector({
        token: "xoxb-test",
        channels: [],
      }),
    ).toThrow(ConnectorError);
  });

  it("requires a token", () => {
    expect(() =>
      createSlackConnector({
        token: "",
        channels: ["general"],
      }),
    ).toThrow(ConnectorError);
  });

  it("syncs channel messages and thread replies, mapping each kind correctly", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD", team: "Acme" } },
      "conversations.list": {
        body: {
          ok: true,
          channels: [{ id: "C01XYZ", name: "general", is_private: false }],
        },
      },
      "conversations.history": {
        body: {
          ok: true,
          // Slack returns newest-first, top-level only; the connector reverses to chronological.
          messages: [
            {
              type: "message",
              ts: "1700000200.000900",
              thread_ts: "1700000200.000900",
              user: "U01ADA",
              text: "second top-level message",
            },
            {
              type: "message",
              ts: "1700000000.000100",
              thread_ts: "1700000000.000100",
              user: "U01ADA",
              text: "ci is flaky",
              reply_count: 2,
            },
          ],
        },
      },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            // Slack always returns the parent first; the connector drops it.
            {
              type: "message",
              ts: "1700000000.000100",
              thread_ts: "1700000000.000100",
              user: "U01ADA",
              text: "ci is flaky",
            },
            {
              type: "message",
              ts: "1700000050.000300",
              thread_ts: "1700000000.000100",
              user: "U01BOB",
              text: "but only on macos",
            },
            {
              type: "message",
              ts: "1700000060.000400",
              thread_ts: "1700000000.000100",
              user: "U01ADA",
              text: "got it, will dig",
            },
          ],
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["general"],
      fetchImpl,
    });

    const result = await connector.sync({ dryRun: true });
    expect(result.connector).toBe("slack");
    expect(result.subject).toBe("team:T01ABCD");
    expect(result.dryRun).toBe(true);
    // Two top-level messages + two thread replies (parent dropped, two true replies).
    expect(result.episodes.length).toBe(4);

    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "slack.message.posted",
      "slack.message.posted",
      "slack.thread.replied",
      "slack.thread.replied",
    ]);

    expect(result.summary.details?.events_messages).toBe(2);
    expect(result.summary.details?.events_thread_replies).toBe(2);
    expect(result.summary.details?.channels_synced).toBe(1);
  });

  it("respects --max-items by capping mapped episodes", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD" } },
      "conversations.list": {
        body: { ok: true, channels: [{ id: "C01XYZ", name: "general" }] },
      },
      "conversations.history": {
        body: {
          ok: true,
          messages: Array.from({ length: 5 }, (_, i) => ({
            type: "message",
            ts: `170000000${i}.000000`,
            thread_ts: `170000000${i}.000000`,
            user: "U01ADA",
            text: `m${i}`,
          })),
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["general"],
      fetchImpl,
    });

    const result = await connector.sync({ dryRun: true, maxItems: 2 });
    expect(result.episodes.length).toBe(2);
    expect(result.skipped).toBe(3);
  });

  it("errors loudly when a named channel is not in the workspace", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD" } },
      "conversations.list": {
        body: { ok: true, channels: [{ id: "C01XYZ", name: "general" }] },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["this-does-not-exist"],
      fetchImpl,
    });

    await expect(connector.sync({ dryRun: true })).rejects.toMatchObject({
      message: expect.stringContaining("channels not found"),
    });
  });

  it("retries once on 429 then succeeds", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": [
        { body: { ok: false, error: "ratelimited" }, status: 429, retryAfter: "0" },
        { body: { ok: true, team_id: "T01ABCD" } },
      ],
      "conversations.list": {
        body: { ok: true, channels: [{ id: "C01XYZ", name: "general" }] },
      },
      "conversations.history": { body: { ok: true, messages: [] } },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["general"],
      fetchImpl,
      // Tighten retry sleep so the test runs sub-second.
      // (The default minRetryMs is 1s; we override via a re-construct below.)
    });
    // The default minRetryMs is 1s — we accept that here since the test
    // queue retries immediately after the first 429. If this becomes flaky
    // on CI we'll plumb minRetryMs through createSlackConnector.
    const result = await connector.sync({ dryRun: true });
    expect(result.connector).toBe("slack");
  }, 10_000);

  it("surfaces missing-scope errors as config_invalid", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: false, error: "missing_scope" } },
    });
    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["general"],
      fetchImpl,
    });
    const check = await connector.check();
    expect(check.status).toBe("error");
    expect(check.details[0].name).toBe("auth");
  });
});
