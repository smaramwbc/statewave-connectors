import { describe, it, expect, vi } from "vitest";
import {
  createGmailPubsubHandler,
  InMemoryGmailHistoryCursorStore,
  InMemoryGmailPubsubDedupCache,
  type GmailHistoryReader,
  type StatewaveIngest,
} from "../src/index.js";
import type { GmailMessage } from "../src/types.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const TOKEN = "shh-pubsub";
const EMAIL = "owner@acme.example";

function buildMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "msg_42",
    thread_id: "thread_7",
    internal_date: "2026-05-09T08:00:00.000Z",
    label_ids: ["INBOX"],
    from: "alice@vendor.example",
    to: EMAIL,
    subject: "Following up on the proposal",
    body: "Just checking in on the proposal we sent last week.",
    snippet: "Just checking in",
    ...overrides,
  };
}

function makeReader(
  messages: ReadonlyArray<GmailMessage>,
  options: { tooOld?: boolean; nextHistoryId?: string } = {},
): GmailHistoryReader {
  return {
    listHistoryMessages: vi.fn(async () => ({
      messages,
      nextHistoryId: options.nextHistoryId,
      tooOld: !!options.tooOld,
    })),
    getProfile: vi.fn(async () => ({ historyId: options.nextHistoryId, emailAddress: EMAIL })),
  };
}

function buildPubsubBody(payload: { emailAddress: string; historyId: string | number }, messageId = "ps_1") {
  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return JSON.stringify({
    message: {
      data,
      messageId,
      publishTime: "2026-05-09T08:00:00Z",
    },
    subscription: "projects/test/subscriptions/gmail-push",
  });
}

function buildRequest(
  body: string,
  options: { token?: string; pathToken?: string } = {},
): Request {
  const queryToken = options.token ?? TOKEN;
  const path = options.pathToken !== undefined
    ? `/gmail/events/${options.pathToken}`
    : `/gmail/events?token=${encodeURIComponent(queryToken)}`;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("createGmailPubsubHandler — config", () => {
  it("rejects without pathToken or verifyAuth", () => {
    expect(() =>
      createGmailPubsubHandler({
        ingest: vi.fn(),
        historyReader: makeReader([]),
      }),
    ).toThrow();
  });

  it("rejects without ingest sink AND statewaveUrl", () => {
    expect(() =>
      createGmailPubsubHandler({
        pathToken: TOKEN,
        historyReader: makeReader([]),
      }),
    ).toThrow();
  });

  it("rejects without credentials AND historyReader", () => {
    expect(() =>
      createGmailPubsubHandler({
        pathToken: TOKEN,
        ingest: vi.fn(),
      }),
    ).toThrow();
  });
});

describe("createGmailPubsubHandler — auth", () => {
  it("returns 401 on bad path-token", async () => {
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest: vi.fn(),
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "100" });
    const res = await handler(buildRequest(body, { token: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("accepts the token in the URL path suffix", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "100" });
    const res = await handler(buildRequest(body, { pathToken: TOKEN }));
    expect(res.status).toBe(200);
  });

  it("falls back to a custom verifyAuth callback before checking the path token", async () => {
    const verifyAuth = vi.fn().mockResolvedValue(false);
    const handler = createGmailPubsubHandler({
      verifyAuth,
      historyReader: makeReader([]),
      ingest: vi.fn(),
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "100" });
    const res = await handler(buildRequest(body));
    expect(res.status).toBe(401);
    expect(verifyAuth).toHaveBeenCalledTimes(1);
  });
});

describe("createGmailPubsubHandler — cursor & dispatch", () => {
  it("cold-start delivery only persists the historyId, ingests nothing", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const cursorStore = new InMemoryGmailHistoryCursorStore();
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([buildMessage()]),
      ingest,
      historyCursorStore: cursorStore,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "200" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { cold_start?: boolean; history_id?: string };
    expect(res.status).toBe(200);
    expect(json.cold_start).toBe(true);
    expect(json.history_id).toBe("200");
    expect(cursorStore.get(EMAIL)).toBe("200");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("walks history from the persisted cursor and ingests new messages", async () => {
    const captured: StatewaveEpisode[] = [];
    const ingest: StatewaveIngest = vi.fn(async (ep) => {
      captured.push(ep);
    });
    const cursorStore = new InMemoryGmailHistoryCursorStore({ seed: { [EMAIL]: "100" } });
    const reader = makeReader(
      [
        buildMessage({ id: "msg_a", subject: "Reply 1" }),
        buildMessage({
          id: "msg_b",
          subject: "Reply 2",
          label_ids: ["SENT"],
          to: "bob@vendor.example",
          from: EMAIL,
        }),
      ],
      { nextHistoryId: "150" },
    );
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: reader,
      ingest,
      historyCursorStore: cursorStore,
      query: "label:inbox",
      labelIds: ["INBOX"],
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "150" });
    const res = await handler(buildRequest(body));
    expect(res.status).toBe(200);
    expect(captured.map((e) => e.kind)).toEqual([
      "gmail.message.received",
      "gmail.message.sent",
    ]);
    expect(captured[0]?.subject).toBe("relationship:alice@vendor.example");
    expect(captured[1]?.subject).toBe("relationship:bob@vendor.example");
    expect(reader.listHistoryMessages).toHaveBeenCalledWith({
      startHistoryId: "100",
      query: "label:inbox",
      labelIds: ["INBOX"],
      maxItems: undefined,
    });
    expect(cursorStore.get(EMAIL)).toBe("150");
  });

  it("resets the cursor and ack-skips when Gmail says the historyId is too old", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const cursorStore = new InMemoryGmailHistoryCursorStore({ seed: { [EMAIL]: "1" } });
    const reader = makeReader([], { tooOld: true });
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: reader,
      ingest,
      historyCursorStore: cursorStore,
      logger: () => undefined,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "999" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { cursor_too_old?: boolean; history_id?: string };
    expect(res.status).toBe(200);
    expect(json.cursor_too_old).toBe(true);
    expect(json.history_id).toBe("999");
    expect(cursorStore.get(EMAIL)).toBe("999");
    expect(ingest).not.toHaveBeenCalled();
  });

  it("acks 200 even when the history walk throws (Pub/Sub would retry)", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const cursorStore = new InMemoryGmailHistoryCursorStore({ seed: { [EMAIL]: "100" } });
    const reader: GmailHistoryReader = {
      listHistoryMessages: vi.fn(async () => {
        throw new Error("gmail down");
      }),
      getProfile: vi.fn(async () => ({})),
    };
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: reader,
      ingest,
      historyCursorStore: cursorStore,
      logger: () => undefined,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "150" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { walk_failed?: boolean };
    expect(res.status).toBe(200);
    expect(json.walk_failed).toBe(true);
    // Cursor stays put so the next notification re-attempts the same window.
    expect(cursorStore.get(EMAIL)).toBe("100");
  });

  it("acks 200 when one ingest throws but processes the rest", async () => {
    let callIdx = 0;
    const ingest: StatewaveIngest = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) throw new Error("downstream blip");
    });
    const cursorStore = new InMemoryGmailHistoryCursorStore({ seed: { [EMAIL]: "100" } });
    const reader = makeReader(
      [buildMessage({ id: "m1" }), buildMessage({ id: "m2" }), buildMessage({ id: "m3" })],
      { nextHistoryId: "200" },
    );
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: reader,
      ingest,
      historyCursorStore: cursorStore,
      logger: () => undefined,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "200" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { ingested?: number };
    expect(res.status).toBe(200);
    expect(json.ingested).toBe(2);
    expect(cursorStore.get(EMAIL)).toBe("200");
  });
});

describe("createGmailPubsubHandler — tolerance & dedup", () => {
  it("ignores envelopes missing message.data with 200 + 'missing_message_data'", async () => {
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest: vi.fn(),
    });
    const body = JSON.stringify({ message: {}, subscription: "x" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("missing_message_data");
  });

  it("returns 400 on unparseable Gmail data payload", async () => {
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest: vi.fn(),
      logger: () => undefined,
    });
    const data = Buffer.from("not-json{{", "utf8").toString("base64");
    const body = JSON.stringify({
      message: { data, messageId: "ps_x" },
      subscription: "x",
    });
    const res = await handler(buildRequest(body));
    expect(res.status).toBe(400);
  });

  it("ignores payloads missing emailAddress/historyId with 200 + 'missing_watch_fields'", async () => {
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest: vi.fn(),
    });
    const data = Buffer.from(JSON.stringify({}), "utf8").toString("base64");
    const body = JSON.stringify({ message: { data, messageId: "ps_y" }, subscription: "x" });
    const res = await handler(buildRequest(body));
    const json = (await res.json()) as { ignored?: string };
    expect(json.ignored).toBe("missing_watch_fields");
  });

  it("dedups Pub/Sub redeliveries by messageId", async () => {
    const ingest: StatewaveIngest = vi.fn();
    const cursorStore = new InMemoryGmailHistoryCursorStore({ seed: { [EMAIL]: "100" } });
    const reader = makeReader([buildMessage()], { nextHistoryId: "150" });
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: reader,
      ingest,
      historyCursorStore: cursorStore,
    });
    const body = buildPubsubBody({ emailAddress: EMAIL, historyId: "150" }, "ps_dup_1");
    await handler(buildRequest(body));
    const res2 = await handler(buildRequest(body));
    expect(ingest).toHaveBeenCalledTimes(1);
    const json = (await res2.json()) as { deduplicated?: boolean };
    expect(json.deduplicated).toBe(true);
  });

  it("exposes the historyCursorStore + dedup cache for cross-handler sharing", () => {
    const historyCursorStore = new InMemoryGmailHistoryCursorStore();
    const dedupCache = new InMemoryGmailPubsubDedupCache();
    const handler = createGmailPubsubHandler({
      pathToken: TOKEN,
      historyReader: makeReader([]),
      ingest: vi.fn(),
      historyCursorStore,
      dedupCache,
    });
    expect(handler.historyCursorStore).toBe(historyCursorStore);
    expect(handler.dedupCache).toBe(dedupCache);
  });
});
