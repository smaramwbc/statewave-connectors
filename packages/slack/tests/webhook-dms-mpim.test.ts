// DM + MPIM webhook event dispatch (v0.4.0). When the Slack app subscribes
// to `message.im` / `message.mpim` events and the webhook receives them,
// they're routed through the same DM/MPIM kinds the pull connector uses
// — gated by explicit `acceptDms` / `acceptMpim` config flags so a
// channel-only deployment doesn't accidentally start ingesting DMs the
// moment someone toggles a Slack-app subscription.

import { describe, it, expect, vi } from "vitest";
import {
  computeSignature,
  createSlackWebhookHandler,
  type StatewaveIngest,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "shhh";
const NOW_TS = 1_700_000_300;
const REQ_TS = 1_700_000_000;

function buildSignedRequest(body: string, timestamp = REQ_TS, secret = SECRET): Request {
  const sig = "v0=" + computeSignature(secret, timestamp, body);
  return new Request("http://localhost/slack/events", {
    method: "POST",
    headers: {
      "x-slack-signature": sig,
      "x-slack-request-timestamp": String(timestamp),
      "content-type": "application/json",
    },
    body,
  });
}

function dmCallback(overrides: Partial<{ user: string; text: string; ts: string; channel: string }> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: "Ev_DM_001",
    event_time: 1_700_000_000,
    team_id: "T01ABCD",
    event: {
      type: "message",
      channel: overrides.channel ?? "D01ALICE",
      channel_type: "im",
      user: overrides.user ?? "U01ALICE",
      text: overrides.text ?? "hi from a DM",
      ts: overrides.ts ?? "1700000000.000100",
    },
  });
}

function mpimCallback(overrides: Partial<{ text: string; ts: string; channel: string; user: string }> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: "Ev_MP_001",
    event_time: 1_700_000_000,
    team_id: "T01ABCD",
    event: {
      type: "message",
      channel: overrides.channel ?? "G01TEAM",
      channel_type: "mpim",
      user: overrides.user ?? "U01ALICE",
      text: overrides.text ?? "hey team",
      ts: overrides.ts ?? "1700000000.000200",
    },
  });
}

describe("createSlackWebhookHandler — DM dispatch (v0.4.0)", () => {
  it("filters DM events out by default (acceptDms unset)", async () => {
    const ingest: StatewaveIngest = vi.fn().mockResolvedValue(undefined);
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: [],
      ingest,
      now: () => NOW_TS,
    });
    const res = await handler(buildSignedRequest(dmCallback()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ignored?: string };
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe("dms_disabled");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("dispatches DM events to slack.dm.message.posted on dm:<user> when acceptDms is true", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: [],
      acceptDms: true,
      ingest,
      now: () => NOW_TS,
    });
    const res = await handler(buildSignedRequest(dmCallback()));
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("slack.dm.message.posted");
    expect(captured?.subject).toBe("dm:U01ALICE");
    expect(captured?.metadata?.dm_user_id).toBe("U01ALICE");
  });

  it("DM thread replies dispatch to slack.dm.thread.replied", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: [],
      acceptDms: true,
      ingest,
      now: () => NOW_TS,
    });
    // Thread reply: ts != thread_ts. The Slack Events API delivers
    // these with a `thread_ts` that isn't the same as `ts`.
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_DM_002",
      event_time: 1_700_000_000,
      team_id: "T01ABCD",
      event: {
        type: "message",
        channel: "D01ALICE",
        channel_type: "im",
        user: "U01ALICE",
        text: "DM thread reply",
        ts: "1700000050.000200",
        thread_ts: "1700000000.000100",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("slack.dm.thread.replied");
    expect(captured?.subject).toBe("dm:U01ALICE");
  });
});

describe("createSlackWebhookHandler — MPIM dispatch (v0.4.0)", () => {
  it("filters MPIM events out by default (acceptMpim unset)", async () => {
    const ingest: StatewaveIngest = vi.fn().mockResolvedValue(undefined);
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: [],
      ingest,
      now: () => NOW_TS,
    });
    const res = await handler(buildSignedRequest(mpimCallback()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; ignored?: string };
    expect(json.ok).toBe(true);
    expect(json.ignored).toBe("mpim_disabled");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("dispatches MPIM events to slack.mpim.message.posted on mpim:<channel> when acceptMpim is true", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: [],
      acceptMpim: true,
      ingest,
      now: () => NOW_TS,
    });
    const res = await handler(buildSignedRequest(mpimCallback()));
    expect(res.status).toBe(200);
    expect(captured?.kind).toBe("slack.mpim.message.posted");
    expect(captured?.subject).toBe("mpim:G01TEAM");
    expect(captured?.metadata?.is_mpim).toBe(true);
  });

  it("DMs and MPIMs bypass the channel allowlist", async () => {
    // Allowlist explicitly excludes the DM/MPIM channel ids.
    const captured: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured.push(ep);
    });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C_NOPE"], // channel allowlist; DM/MPIM channels not in it
      acceptDms: true,
      acceptMpim: true,
      ingest,
      now: () => NOW_TS,
    });
    await handler(buildSignedRequest(dmCallback()));
    await handler(buildSignedRequest(mpimCallback()));
    expect(captured).toHaveLength(2);
    expect(captured.map((e) => e.kind).sort()).toEqual([
      "slack.dm.message.posted",
      "slack.mpim.message.posted",
    ]);
  });

  it("normal channel events still flow when acceptDms / acceptMpim are off", async () => {
    let captured: StatewaveEpisode | undefined;
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured = ep;
    });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest,
      now: () => NOW_TS,
    });
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev_CH_001",
      event_time: 1_700_000_000,
      team_id: "T01ABCD",
      event: {
        type: "message",
        channel: "C01XYZ",
        channel_type: "channel",
        user: "U01ADA",
        text: "channel message",
        ts: "1700000000.000100",
      },
    });
    await handler(buildSignedRequest(body));
    expect(captured?.kind).toBe("slack.message.posted");
    expect(captured?.subject).toBe("team:T01ABCD");
  });
});
