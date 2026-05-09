import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createNotionConnector } from "../src/index.js";

interface FakeResponseSpec {
  body: unknown;
  status?: number;
}

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

const SEARCH_TWO_PAGES = {
  object: "list",
  results: [
    {
      object: "page",
      id: "page_a",
      created_time: "2026-05-09T08:00:00.000Z",
      last_edited_time: "2026-05-09T08:00:00.000Z",
      archived: false,
      url: "https://www.notion.so/Acme-decisions-page_a",
      parent: { type: "workspace", workspace: true },
      properties: {
        title: { type: "title", title: [{ plain_text: "Decision A" }] },
      },
    },
    {
      object: "page",
      id: "page_b",
      created_time: "2026-05-08T08:00:00.000Z",
      last_edited_time: "2026-05-09T11:00:00.000Z",
      archived: false,
      url: "https://www.notion.so/Acme-decisions-page_b",
      parent: { type: "database_id", database_id: "db_1" },
      properties: {
        Name: { type: "title", title: [{ plain_text: "Decision B" }] },
      },
    },
  ],
  has_more: false,
  next_cursor: null,
};

describe("createNotionConnector — config validation", () => {
  it("requires a token", () => {
    expect(() =>
      createNotionConnector({
        // @ts-expect-error testing the runtime guard
        token: undefined,
      }),
    ).toThrow(ConnectorError);
  });
});

describe("createNotionConnector — sync", () => {
  it("emits notion.page.created for new pages and notion.page.updated for edits", async () => {
    const fetchImpl = fakeFetch({
      "/v1/search": { body: SEARCH_TWO_PAGES },
    });

    const connector = createNotionConnector({ token: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    expect(result.episodes).toHaveLength(2);
    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual(["notion.page.created", "notion.page.updated"]);
    expect(result.summary.details?.events_page_created).toBe(1);
    expect(result.summary.details?.events_page_updated).toBe(1);
  });

  it("subjects on workspace:notion by default", async () => {
    const fetchImpl = fakeFetch({ "/v1/search": { body: SEARCH_TWO_PAGES } });
    const connector = createNotionConnector({ token: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true });
    for (const ep of result.episodes) {
      expect(ep.subject).toBe("workspace:notion");
    }
  });

  it("respects a caller-supplied subject", async () => {
    const fetchImpl = fakeFetch({ "/v1/search": { body: SEARCH_TWO_PAGES } });
    const connector = createNotionConnector({ token: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true, subject: "repo:acme/platform" });
    for (const ep of result.episodes) {
      expect(ep.subject).toBe("repo:acme/platform");
    }
  });

  it("opts into page body via --include pages,content", async () => {
    const fetchImpl = fakeFetch({
      "/v1/search": {
        body: {
          object: "list",
          results: [
            {
              object: "page",
              id: "page_c",
              created_time: "2026-05-09T08:00:00.000Z",
              last_edited_time: "2026-05-09T08:00:00.000Z",
              archived: false,
              url: "https://www.notion.so/page_c",
              parent: { type: "workspace", workspace: true },
              properties: {
                title: { type: "title", title: [{ plain_text: "ADR: pin notion version" }] },
              },
            },
          ],
          has_more: false,
        },
      },
      "/v1/blocks/page_c/children": {
        body: {
          results: [
            {
              id: "blk_1",
              type: "heading_2",
              heading_2: { rich_text: [{ plain_text: "Context" }] },
            },
            {
              id: "blk_2",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "We need stability." }] },
            },
            {
              id: "blk_3",
              type: "bulleted_list_item",
              bulleted_list_item: { rich_text: [{ plain_text: "Pin to 2022-06-28" }] },
            },
            {
              id: "blk_4",
              type: "to_do",
              to_do: { rich_text: [{ plain_text: "Update README" }], checked: false },
            },
            {
              id: "blk_5",
              type: "code",
              code: { rich_text: [{ plain_text: "console.log('hi')" }], language: "javascript" },
            },
            {
              id: "blk_6",
              type: "callout",
              callout: { rich_text: [{ plain_text: "callouts are not rendered" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        },
      },
    });

    const defaultRun = await createNotionConnector({ token: "tok", fetchImpl }).sync({
      dryRun: true,
    });
    expect(defaultRun.episodes[0]?.text).toBe(
      'created page "ADR: pin notion version"',
    );

    const withContent = await createNotionConnector({ token: "tok", fetchImpl }).sync({
      dryRun: true,
      include: ["pages", "content"],
    });
    const text = withContent.episodes[0]?.text ?? "";
    expect(text).toContain("## Context");
    expect(text).toContain("We need stability.");
    expect(text).toContain("- Pin to 2022-06-28");
    expect(text).toContain("[ ] Update README");
    expect(text).toContain("```javascript\nconsole.log('hi')\n```");
    expect(text).not.toContain("callouts are not rendered");
  });

  it("uses Bearer auth + Notion-Version header", async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) captured = { ...captured, ...headers };
      if (u.includes("/v1/search"))
        return new Response(
          JSON.stringify({ object: "list", results: [], has_more: false }),
          { status: 200 },
        );
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await createNotionConnector({ token: "tok-xyz", fetchImpl }).sync({ dryRun: true });
    expect(captured.Authorization).toBe("Bearer tok-xyz");
    expect(captured["Notion-Version"]).toBe("2022-06-28");
  });

  it("translates 401 into auth_failed", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    }) as typeof fetch;
    const connector = createNotionConnector({ token: "tok", fetchImpl });
    await expect(connector.sync({ dryRun: true })).rejects.toThrow(/401/);
  });

  it("respects --since by skipping pages whose last_edited_time is older", async () => {
    const fetchImpl = fakeFetch({
      "/v1/search": {
        body: {
          object: "list",
          results: [
            {
              object: "page",
              id: "page_old",
              created_time: "2025-12-01T08:00:00.000Z",
              last_edited_time: "2025-12-01T08:00:00.000Z",
              archived: false,
              url: "https://www.notion.so/old",
              parent: { type: "workspace", workspace: true },
              properties: { title: { type: "title", title: [{ plain_text: "Old" }] } },
            },
            {
              object: "page",
              id: "page_new",
              created_time: "2026-05-09T08:00:00.000Z",
              last_edited_time: "2026-05-09T08:00:00.000Z",
              archived: false,
              url: "https://www.notion.so/new",
              parent: { type: "workspace", workspace: true },
              properties: { title: { type: "title", title: [{ plain_text: "New" }] } },
            },
          ],
          has_more: false,
        },
      },
    });

    const connector = createNotionConnector({ token: "tok", fetchImpl });
    const result = await connector.sync({ dryRun: true, since: "2026-01-01" });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.text).toContain('"New"');
  });
});
