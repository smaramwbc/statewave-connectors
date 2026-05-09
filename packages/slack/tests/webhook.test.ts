import { describe, it, expect, vi } from "vitest";
import {
  computeSignature,
  createSlackWebhookHandler,
  InMemoryDedupCache,
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

function eventCallback(overrides: Partial<{
  event_id: string;
  channel: string;
  text: string;
  ts: string;
  thread_ts: string;
  user: string;
  subtype: string;
  team_id: string;
}> = {}): string {
  return JSON.stringify({
    type: "event_callback",
    event_id: overrides.event_id ?? "Ev01ABCDEF",
    event_time: 1_700_000_000,
    team_id: overrides.team_id ?? "T01ABCD",
    event: {
      type: "message",
      channel: overrides.channel ?? "C01XYZ",
      user: overrides.user ?? "U01ADA",
      text: overrides.text ?? "hello world",
      ts: overrides.ts ?? "1700000000.000100",
      thread_ts: overrides.thread_ts,
      subtype: overrides.subtype,
    },
  });
}

describe("createSlackWebhookHandler", () => {
  it("rejects requests without a custom ingest sink AND without statewaveUrl", () => {
    expect(() =>
      createSlackWebhookHandler({ signingSecret: SECRET, channels: ["C01XYZ"] }),
    ).toThrow(/statewaveUrl or a custom ingest/);
  });

  it("rejects requests missing signingSecret", () => {
    expect(() =>
      createSlackWebhookHandler({
        // @ts-expect-error testing runtime guard
        signingSecret: undefined,
        channels: ["C01XYZ"],
        ingest: async () => {},
      }),
    ).toThrow(/signingSecret/);
  });

  it("returns 401 on missing signature headers", async () => {
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {},
      now: () => NOW_TS,
      logger: () => {},
    });
    const res = await handler(
      new Request("http://localhost/slack/events", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on bad signature", async () => {
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {},
      now: () => NOW_TS,
      logger: () => {},
    });
    const res = await handler(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: {
          "x-slack-signature": "v0=" + "0".repeat(64),
          "x-slack-request-timestamp": String(REQ_TS),
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("echoes the challenge on url_verification", async () => {
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {},
      now: () => NOW_TS,
      logger: () => {},
    });
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { challenge: string };
    expect(json.challenge).toBe("abc123");
  });

  it("ingests a top-level message event", async () => {
    const ingested: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = async (ep) => {
      ingested.push(ep);
    };
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest,
      now: () => NOW_TS,
      logger: () => {},
    });
    const res = await handler(buildSignedRequest(eventCallback({ text: "hi" })));
    expect(res.status).toBe(200);
    expect(ingested).toHaveLength(1);
    const ep = ingested[0]!;
    expect(ep.kind).toBe("slack.message.posted");
    expect(ep.subject).toBe("team:T01ABCD");
    expect(ep.text).toContain("hi");
    expect(ep.metadata?.channel_id).toBe("C01XYZ");
  });

  it("maps a thread reply to slack.thread.replied", async () => {
    const ingested: StatewaveEpisode[] = [];
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async (ep) => {
        ingested.push(ep);
      },
      now: () => NOW_TS,
      logger: () => {},
    });
    const body = eventCallback({
      ts: "1700000050.000200",
      thread_ts: "1700000000.000100",
    });
    await handler(buildSignedRequest(body));
    expect(ingested[0]!.kind).toBe("slack.thread.replied");
  });

  it("dedups retried deliveries by event_id", async () => {
    const ingest = vi.fn(async () => {});
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest,
      now: () => NOW_TS,
      logger: () => {},
    });
    const body = eventCallback({ event_id: "EvDUP" });
    const r1 = await handler(buildSignedRequest(body));
    const r2 = await handler(buildSignedRequest(body));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(((await r2.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
  });

  it("filters events from channels not in the allowlist", async () => {
    const ingest = vi.fn(async () => {});
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"], // only this one
      ingest,
      now: () => NOW_TS,
      logger: () => {},
    });
    const body = eventCallback({ channel: "C02NOT_ALLOWED" });
    const res = await handler(buildSignedRequest(body));
    expect(res.status).toBe(200);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("skips channel_join / channel_leave / empty-text messages", async () => {
    const ingest = vi.fn(async () => {});
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest,
      now: () => NOW_TS,
      logger: () => {},
    });
    for (const body of [
      eventCallback({ subtype: "channel_join", event_id: "Ev1" }),
      eventCallback({ subtype: "channel_leave", event_id: "Ev2" }),
      eventCallback({ text: "", event_id: "Ev3" }),
      eventCallback({ text: "   ", event_id: "Ev4" }),
    ]) {
      await handler(buildSignedRequest(body));
    }
    expect(ingest).not.toHaveBeenCalled();
  });

  it("acks 200 even when ingest fails (Slack stops retrying)", async () => {
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {
        throw new Error("Statewave 503");
      },
      now: () => NOW_TS,
      logger: () => {},
    });
    const res = await handler(buildSignedRequest(eventCallback({ event_id: "EvERR" })));
    expect(res.status).toBe(200);
  });

  it("rejects non-POST methods", async () => {
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {},
      now: () => NOW_TS,
      logger: () => {},
    });
    const res = await handler(new Request("http://localhost/slack/events"));
    expect(res.status).toBe(405);
  });

  it("uses an injected dedupCache when provided", async () => {
    const cache = new InMemoryDedupCache({ maxEntries: 100 });
    const handler = createSlackWebhookHandler({
      signingSecret: SECRET,
      channels: ["C01XYZ"],
      ingest: async () => {},
      dedupCache: cache,
      now: () => NOW_TS,
      logger: () => {},
    });
    expect(handler.dedupCache).toBe(cache);
  });
});
