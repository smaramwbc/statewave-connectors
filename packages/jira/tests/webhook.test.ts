import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  createJiraWebhookHandler,
  type JiraWebhookConfig,
} from "../src/index.js";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";

const SECRET = "whsec_test";
const BASE_URL = "https://acme.atlassian.net";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function req(body: unknown, opts: { signature?: string; method?: string } = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({ "content-type": "application/json" });
  const sig = opts.signature ?? sign(raw);
  if (sig !== "") headers.set("x-hub-signature", sig);
  return new Request("http://localhost/jira/events", {
    method: opts.method ?? "POST",
    headers,
    body: opts.method && opts.method !== "POST" ? undefined : raw,
  });
}

function capturing(extra: Partial<JiraWebhookConfig> = {}) {
  const episodes: StatewaveEpisode[] = [];
  const handler = createJiraWebhookHandler({
    signingSecret: SECRET,
    baseUrl: BASE_URL,
    ingest: async (e) => {
      episodes.push(e);
    },
    ...extra,
  });
  return { handler, episodes };
}

const issuePayload = (over: Record<string, unknown> = {}) => ({
  timestamp: 1_716_000_000_000,
  webhookEvent: "jira:issue_created",
  issue: {
    key: "ENG-42",
    fields: {
      summary: "Login button is misaligned",
      description: { type: "doc", content: [{ type: "text", text: "Repro on Safari" }] },
      status: { name: "To Do", statusCategory: { key: "new" } },
      project: { key: "ENG" },
      reporter: { accountId: "acc-1", displayName: "Dana Reporter", emailAddress: "dana@acme.com" },
      created: "2026-05-20T09:00:00.000Z",
      updated: "2026-05-20T09:00:00.000Z",
    },
    ...over,
  },
});

describe("createJiraWebhookHandler — construction guards", () => {
  it("requires a signing secret", () => {
    expect(() =>
      createJiraWebhookHandler({ signingSecret: "", baseUrl: BASE_URL, ingest: async () => {} }),
    ).toThrow(/signingSecret/);
  });
  it("requires a base URL", () => {
    expect(() =>
      createJiraWebhookHandler({ signingSecret: SECRET, baseUrl: "", ingest: async () => {} }),
    ).toThrow(/baseUrl/);
  });
  it("requires an ingest sink or statewaveUrl", () => {
    expect(() =>
      createJiraWebhookHandler({ signingSecret: SECRET, baseUrl: BASE_URL }),
    ).toThrow(/statewaveUrl/);
  });
  it("rejects an invalid project key in the allowlist", () => {
    expect(() =>
      createJiraWebhookHandler({
        signingSecret: SECRET,
        baseUrl: BASE_URL,
        ingest: async () => {},
        projects: ["bad-key"],
      }),
    ).toThrow(/project key/);
  });
});

describe("createJiraWebhookHandler — signature verification", () => {
  it("405s non-POST", async () => {
    const { handler } = capturing();
    const res = await handler(req(issuePayload(), { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("401s a missing signature", async () => {
    const { handler } = capturing();
    const res = await handler(req(issuePayload(), { signature: "" }));
    expect(res.status).toBe(401);
  });

  it("401s a wrong signature (computed with the wrong secret)", async () => {
    const { handler, episodes } = capturing();
    const body = JSON.stringify(issuePayload());
    const res = await handler(req(body, { signature: sign(body, "wrong-secret") }));
    expect(res.status).toBe(401);
    expect(episodes).toHaveLength(0);
  });

  it("accepts a valid signature and ingests", async () => {
    const { handler, episodes } = capturing();
    const res = await handler(req(issuePayload()));
    expect(res.status).toBe(200);
    expect(episodes).toHaveLength(1);
  });
});

describe("createJiraWebhookHandler — event mapping", () => {
  it("maps jira:issue_created → jira.issue.created and never leaks the email", async () => {
    const { handler, episodes } = capturing();
    await handler(req(issuePayload()));
    const ep = episodes[0]!;
    expect(ep.kind).toBe("jira.issue.created");
    expect(ep.subject).toBe("project:ENG");
    expect(ep.text).toContain("Login button is misaligned");
    expect(ep.text).toContain("Repro on Safari");
    expect(JSON.stringify(ep)).not.toContain("dana@acme.com");
    expect(ep.metadata?.reporter).toBe("Dana Reporter");
  });

  it("maps a done issue update → jira.issue.resolved", async () => {
    const { handler, episodes } = capturing();
    const payload = issuePayload();
    payload.webhookEvent = "jira:issue_updated";
    payload.issue.fields.status = { name: "Done", statusCategory: { key: "done" } };
    await handler(req(payload));
    expect(episodes[0]!.kind).toBe("jira.issue.resolved");
  });

  it("maps comment_created → jira.comment.created", async () => {
    const { handler, episodes } = capturing();
    const payload = {
      timestamp: 1_716_000_000_001,
      webhookEvent: "comment_created",
      issue: { key: "ENG-42", fields: { project: { key: "ENG" } } },
      comment: {
        id: "10001",
        author: { displayName: "Sam Helper" },
        body: { type: "doc", content: [{ type: "text", text: "Looking into it" }] },
        created: "2026-05-20T10:00:00.000Z",
        updated: "2026-05-20T10:00:00.000Z",
      },
    };
    await handler(req(payload));
    const ep = episodes[0]!;
    expect(ep.kind).toBe("jira.comment.created");
    expect(ep.text).toContain("Looking into it");
    expect(ep.metadata?.issue_key).toBe("ENG-42");
  });

  it("acks-and-skips unsupported events (issue_deleted)", async () => {
    const { handler, episodes } = capturing();
    const payload = issuePayload();
    payload.webhookEvent = "jira:issue_deleted";
    const res = await handler(req(payload));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "unsupported_event" });
    expect(episodes).toHaveLength(0);
  });
});

describe("createJiraWebhookHandler — scoping, dedup, redaction", () => {
  it("skips events outside the project allowlist", async () => {
    const { handler, episodes } = capturing({ projects: ["PLATFORM"] });
    const res = await handler(req(issuePayload()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "project_not_allowlisted" });
    expect(episodes).toHaveLength(0);
  });

  it("dedups a retried delivery of the same event", async () => {
    const { handler, episodes } = capturing();
    const body = JSON.stringify(issuePayload());
    const sig = sign(body);
    const first = await handler(req(body, { signature: sig }));
    const second = await handler(req(body, { signature: sig }));
    expect(await first.json()).toMatchObject({ ingested: true });
    expect(await second.json()).toMatchObject({ deduplicated: true });
    expect(episodes).toHaveLength(1);
  });

  it("applies redaction to episode text when configured", async () => {
    const { handler, episodes } = capturing({ redaction: { email: true } });
    const payload = issuePayload();
    payload.issue.fields.description = {
      type: "doc",
      content: [{ type: "text", text: "ping me at ops@acme.com" }],
    };
    await handler(req(payload));
    expect(episodes[0]!.text).not.toContain("ops@acme.com");
  });
});
