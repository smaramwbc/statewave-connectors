// MPIM (multi-party DM / group DM) ingestion (v0.3.2). Mirrors sync-dms.test.ts:
// when `includeMpim` is true, the connector lists mpim conversations via
// conversations.list?types=mpim, then pulls history for each one alongside the
// channel allowlist. Episodes route under `mpim:<channel_id>` subjects and use
// `slack.mpim.message.posted` / `slack.mpim.thread.replied` kinds.

import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createSlackConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: Record<string, unknown>;
  status?: number;
}

function fakeFetch(handlers: Record<string, FakeResponseSpec | FakeResponseSpec[]>): typeof fetch {
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
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ ok: false, error: "no_handler" }), { status: 404 });
  }) as typeof fetch;
}

describe("createSlackConnector — MPIM mode", () => {
  it("rejects when none of --channels, --include-dms, --include-mpim is set", () => {
    expect(() =>
      createSlackConnector({ token: "xoxb-test", channels: [] }),
    ).toThrow(ConnectorError);
  });

  it("accepts --include-mpim with no channels", () => {
    expect(() =>
      createSlackConnector({
        token: "xoxb-test",
        channels: [],
        includeMpim: true,
      }),
    ).not.toThrow();
  });

  it("ingests mpim history with mpim:<channel_id> subjects + slack.mpim.message.posted kinds", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD", team: "Acme" } },
      "conversations.list": {
        body: {
          ok: true,
          channels: [
            { id: "G01ABC", name: "mpdm-alice--bob--carol-1", is_mpim: true },
            { id: "G02XYZ", name: "mpdm-dave--eve-1", is_mpim: true },
          ],
        },
      },
      "conversations.history": {
        body: {
          ok: true,
          messages: [
            {
              type: "message",
              ts: "1700000000.000100",
              thread_ts: "1700000000.000100",
              user: "U01ALICE",
              text: "hey team",
            },
          ],
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: [],
      includeMpim: true,
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });

    // Two MPIMs × one message each = 2 episodes.
    expect(result.episodes).toHaveLength(2);
    const subjects = result.episodes.map((e) => e.subject).sort();
    expect(subjects).toEqual(["mpim:G01ABC", "mpim:G02XYZ"]);
    expect(result.episodes.every((e) => e.kind === "slack.mpim.message.posted")).toBe(true);
    expect(result.summary.details?.events_mpims).toBe(2);
    expect(result.summary.details?.mpims_synced).toBe(2);
    expect(result.summary.details?.channels_synced).toBe(0);
    expect(result.summary.details?.dms_synced).toBe(0);
  });

  it("MPIM thread replies map to slack.mpim.thread.replied", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD" } },
      "conversations.list": {
        body: {
          ok: true,
          channels: [{ id: "G01ABC", name: "mpdm-team", is_mpim: true }],
        },
      },
      "conversations.history": {
        body: {
          ok: true,
          messages: [
            {
              type: "message",
              ts: "1700000000.000100",
              thread_ts: "1700000000.000100",
              user: "U01ALICE",
              text: "MPIM thread parent",
              reply_count: 1,
            },
          ],
        },
      },
      "conversations.replies": {
        body: {
          ok: true,
          messages: [
            // Parent — connector drops it.
            {
              type: "message",
              ts: "1700000000.000100",
              thread_ts: "1700000000.000100",
              user: "U01ALICE",
              text: "MPIM thread parent",
            },
            // Real reply.
            {
              type: "message",
              ts: "1700000050.000200",
              thread_ts: "1700000000.000100",
              user: "U02BOB",
              text: "MPIM thread reply",
            },
          ],
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: [],
      includeMpim: true,
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });

    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["slack.mpim.message.posted", "slack.mpim.thread.replied"]);
    // Both share the same mpim:<channel_id> subject.
    expect(new Set(result.episodes.map((e) => e.subject))).toEqual(new Set(["mpim:G01ABC"]));
  });

  it("renders mpim messages with '(group DM)' suffix instead of '#channel'", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD" } },
      "conversations.list": {
        body: {
          ok: true,
          channels: [{ id: "G01ABC", name: "mpdm-alice--bob", is_mpim: true }],
        },
      },
      "conversations.history": {
        body: {
          ok: true,
          messages: [
            {
              type: "message",
              ts: "1700000000.000100",
              user: "U01ALICE",
              text: "hello group",
            },
          ],
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: [],
      includeMpim: true,
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes[0]?.text).toContain("(group DM)");
    expect(result.episodes[0]?.text).not.toContain("#mpdm");
    expect(result.episodes[0]?.metadata?.is_mpim).toBe(true);
  });

  it("mixes channels + DMs + MPIMs in a single sync", async () => {
    const fetchImpl = fakeFetch({
      "auth.test": { body: { ok: true, team_id: "T01ABCD" } },
      // First conversations.list call resolves the channel; second + third
      // resolve DMs and MPIMs respectively.
      "conversations.list": [
        {
          body: {
            ok: true,
            channels: [{ id: "C01XYZ", name: "general", is_private: false }],
          },
        },
        {
          body: {
            ok: true,
            channels: [{ id: "D01ALICE", is_im: true, user: "U01ALICE" }],
          },
        },
        {
          body: {
            ok: true,
            channels: [{ id: "G01ABC", name: "mpdm-team", is_mpim: true }],
          },
        },
      ],
      // Same history payload for all three (one message each).
      "conversations.history": {
        body: {
          ok: true,
          messages: [
            {
              type: "message",
              ts: "1700000000.000100",
              user: "U01AUTHOR",
              text: "shared text",
            },
          ],
        },
      },
    });

    const connector = createSlackConnector({
      token: "xoxb-test",
      channels: ["general"],
      includeDms: true,
      includeMpim: true,
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });

    expect(result.episodes).toHaveLength(3);
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "slack.dm.message.posted",
      "slack.message.posted",
      "slack.mpim.message.posted",
    ]);
    const subjects = result.episodes.map((e) => e.subject).sort();
    expect(subjects).toEqual(["dm:U01ALICE", "mpim:G01ABC", "team:T01ABCD"]);
    expect(result.summary.details?.events_messages).toBe(1);
    expect(result.summary.details?.events_dms).toBe(1);
    expect(result.summary.details?.events_mpims).toBe(1);
  });
});
