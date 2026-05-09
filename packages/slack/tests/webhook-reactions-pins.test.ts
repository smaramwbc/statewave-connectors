// Webhook handling for v0.3 event kinds: reaction_added, reaction_removed,
// pin_added, pin_removed. Built on the same harness as webhook.test.ts —
// signed requests with a fixed timestamp + clock so the signature check
// is deterministic.

import { describe, it, expect } from "vitest";
import {
  computeSignature,
  createSlackWebhookHandler,
  mapSlackPinEvent,
  mapSlackReactionEvent,
  type SlackInboundPin,
  type SlackInboundReaction,
  type StatewaveIngest,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "shhh";
const NOW_TS = 1_700_000_300;
const REQ_TS = 1_700_000_000;

function buildSignedRequest(body: string): Request {
  const sig = "v0=" + computeSignature(SECRET, REQ_TS, body);
  return new Request("http://localhost/slack/events", {
    method: "POST",
    headers: {
      "x-slack-signature": sig,
      "x-slack-request-timestamp": String(REQ_TS),
      "content-type": "application/json",
    },
    body,
  });
}

const baseConfig = {
  signingSecret: SECRET,
  channels: ["C01XYZ"],
  now: () => NOW_TS,
  logger: () => {},
} as const;

const reactionEnvelope = (overrides: Partial<{
  type: "reaction_added" | "reaction_removed";
  user: string;
  reaction: string;
  channel: string;
  ts: string;
  event_id: string;
}> = {}): string =>
  JSON.stringify({
    type: "event_callback",
    event_id: overrides.event_id ?? "Ev01REACT",
    team_id: "T01ABCD",
    event: {
      type: overrides.type ?? "reaction_added",
      user: overrides.user ?? "U01ADA",
      reaction: overrides.reaction ?? "thumbsup",
      item: {
        type: "message",
        channel: overrides.channel ?? "C01XYZ",
        ts: overrides.ts ?? "1700000000.000100",
      },
      event_ts: "1700000000.000100",
    },
  });

const pinEnvelope = (overrides: Partial<{
  type: "pin_added" | "pin_removed";
  user: string;
  channel: string;
  msg_ts: string;
  msg_text: string;
  event_id: string;
}> = {}): string =>
  JSON.stringify({
    type: "event_callback",
    event_id: overrides.event_id ?? "Ev01PIN",
    team_id: "T01ABCD",
    event: {
      type: overrides.type ?? "pin_added",
      user: overrides.user ?? "U01BOSS",
      channel_id: overrides.channel ?? "C01XYZ",
      item: {
        type: "message",
        channel: overrides.channel ?? "C01XYZ",
        created: 1_700_000_050,
        message: {
          ts: overrides.msg_ts ?? "1700000000.000100",
          user: "U01ADA",
          text: overrides.msg_text ?? "this is the pinned message body",
        },
      },
      event_ts: "1700000050.000100",
    },
  });

describe("mapSlackReactionEvent (mapper)", () => {
  const workspace = { team_id: "T01ABCD", team_name: "Acme" };
  const reaction: SlackInboundReaction = {
    type: "reaction_added",
    user: "U01ADA",
    reaction: "thumbsup",
    item: { type: "message", channel: "C01XYZ", ts: "1700000000.000100" },
    event_ts: "1700000000.000100",
  };

  it("maps reaction_added to slack.reaction.added", () => {
    const ep = mapSlackReactionEvent(reaction, { workspace, channelName: "general" });
    expect(ep.kind).toBe("slack.reaction.added");
    expect(ep.subject).toBe("team:T01ABCD");
    expect(ep.text).toContain(":thumbsup:");
    expect(ep.text).toContain("#general");
    expect(ep.metadata?.reaction).toBe("thumbsup");
    expect(ep.source.id).toBe("C01XYZ:1700000000.000100:U01ADA:thumbsup");
  });

  it("maps reaction_removed to slack.reaction.removed", () => {
    const ep = mapSlackReactionEvent(
      { ...reaction, type: "reaction_removed" },
      { workspace },
    );
    expect(ep.kind).toBe("slack.reaction.removed");
    expect(ep.text).toContain("removed reaction");
  });

  it("idempotency keys distinguish add vs remove", () => {
    const a = mapSlackReactionEvent(reaction, { workspace });
    const b = mapSlackReactionEvent({ ...reaction, type: "reaction_removed" }, { workspace });
    expect(a.idempotency_key).not.toBe(b.idempotency_key);
  });
});

describe("mapSlackPinEvent (mapper)", () => {
  const workspace = { team_id: "T01ABCD" };
  const pin: SlackInboundPin = {
    type: "pin_added",
    user: "U01BOSS",
    channel_id: "C01XYZ",
    item: {
      type: "message",
      channel: "C01XYZ",
      created: 1_700_000_050,
      message: {
        ts: "1700000000.000100",
        user: "U01ADA",
        text: "important context for the team",
      },
    },
    event_ts: "1700000050.000100",
  };

  it("maps pin_added to slack.pin.added with the message snippet inlined", () => {
    const ep = mapSlackPinEvent(pin, { workspace, channelName: "decisions" });
    expect(ep.kind).toBe("slack.pin.added");
    expect(ep.text).toContain("pinned");
    expect(ep.text).toContain("#decisions");
    expect(ep.text).toContain("important context");
    expect(ep.metadata?.message_ts).toBe("1700000000.000100");
  });

  it("maps pin_removed to slack.pin.removed", () => {
    const ep = mapSlackPinEvent({ ...pin, type: "pin_removed" }, { workspace });
    expect(ep.kind).toBe("slack.pin.removed");
    expect(ep.text).toContain("unpinned");
  });

  it("renders even when no message body is present", () => {
    const noBody: SlackInboundPin = {
      ...pin,
      item: { ...pin.item, message: undefined },
    };
    const ep = mapSlackPinEvent(noBody, { workspace });
    expect(ep.text).toContain("(unknown ts)");
    // Idempotency falls back to "(unknown ts)" too — verify it doesn't throw.
    expect(typeof ep.idempotency_key).toBe("string");
  });
});

describe("createSlackWebhookHandler (reactions + pins)", () => {
  it("ingests a reaction_added event from an allowed channel", async () => {
    const ingested: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = async (ep) => {
      ingested.push(ep);
    };
    const handler = createSlackWebhookHandler({ ...baseConfig, ingest });
    const res = await handler(buildSignedRequest(reactionEnvelope()));
    expect(res.status).toBe(200);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.kind).toBe("slack.reaction.added");
  });

  it("ingests a reaction_removed event", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    await handler(buildSignedRequest(reactionEnvelope({ type: "reaction_removed", event_id: "Ev01REM" })));
    expect(ingested[0]!.kind).toBe("slack.reaction.removed");
  });

  it("filters reactions targeting a channel that is not allowlisted", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      channels: ["C01XYZ"], // only this channel allowed
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    const res = await handler(
      buildSignedRequest(reactionEnvelope({ channel: "C99NOT_ALLOWED" })),
    );
    expect(res.status).toBe(200);
    expect(ingested).toHaveLength(0);
  });

  it("ignores reactions on non-message items (e.g. file)", async () => {
    const ingested: StatewaveEpisode[] = [];
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev01FILE",
      team_id: "T01ABCD",
      event: {
        type: "reaction_added",
        user: "U01ADA",
        reaction: "thumbsup",
        item: { type: "file", channel: "C01XYZ", file: "F01ABC" },
        event_ts: "1700000000.000100",
      },
    });
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(ingested).toHaveLength(0);
  });

  it("ingests a pin_added event and inlines the pinned message body", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    await handler(buildSignedRequest(pinEnvelope({ msg_text: "the canonical answer" })));
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.kind).toBe("slack.pin.added");
    expect(ingested[0]!.text).toContain("the canonical answer");
  });

  it("ingests a pin_removed event", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    await handler(
      buildSignedRequest(pinEnvelope({ type: "pin_removed", event_id: "Ev01UNPIN" })),
    );
    expect(ingested[0]!.kind).toBe("slack.pin.removed");
  });

  it("filters pins targeting a channel that is not allowlisted", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      ...baseConfig,
      ingest: async (ep) => {
        ingested.push(ep);
      },
    });
    const res = await handler(buildSignedRequest(pinEnvelope({ channel: "C99NOT_ALLOWED" })));
    expect(res.status).toBe(200);
    expect(ingested).toHaveLength(0);
  });
});
