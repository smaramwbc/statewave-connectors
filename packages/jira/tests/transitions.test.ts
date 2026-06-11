import { describe, it, expect } from "vitest";
import {
  JiraClient,
  extractTransitions,
  mapJiraEvent,
  parseSprints,
} from "../src/index.js";
import type { JiraIssue, JiraTransition } from "../src/index.js";

const BASE = "https://acme.atlassian.net";

describe("parseSprints", () => {
  it("parses the array-of-objects Sprint field, keeping name/state/board", () => {
    expect(
      parseSprints([
        { id: 7, name: "Sprint 7", state: "active", boardId: 3 },
        { id: 8, name: "Sprint 8", state: "future", originBoardId: 3 },
      ]),
    ).toEqual([
      { id: 7, name: "Sprint 7", state: "active", boardId: 3 },
      { id: 8, name: "Sprint 8", state: "future", boardId: 3 },
    ]);
  });

  it("drops entries without a name and ignores the legacy string format", () => {
    expect(parseSprints([{ id: 1 }, "com.atlassian...[name=Old]"])).toEqual([]);
    expect(parseSprints(undefined)).toEqual([]);
    expect(parseSprints(null)).toEqual([]);
  });
});

describe("extractTransitions", () => {
  it("extracts status changes from the search histories shape, sorted by created", () => {
    const changelog = {
      histories: [
        {
          id: "200",
          created: "2026-03-02T00:00:00.000Z",
          author: { displayName: "Ada L", emailAddress: "ada@acme.com" },
          items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
        },
        {
          id: "100",
          created: "2026-03-01T00:00:00.000Z",
          author: { displayName: "Bob R" },
          items: [
            { field: "assignee", fromString: null, toString: "Ada L" },
            { field: "status", fromString: "To Do", toString: "In Progress" },
          ],
        },
      ],
    };
    const ts = extractTransitions(changelog, "ENG-1", "ENG", BASE);
    expect(ts.map((t) => [t.fromStatus, t.toStatus])).toEqual([
      ["To Do", "In Progress"],
      ["In Progress", "Done"],
    ]);
    expect(ts[0]!.changeId).toBe("100");
    expect(ts[0]!.author).toBe("Bob R");
    expect(ts[1]!.occurredAt).toBe("2026-03-02T00:00:00.000Z");
    expect(JSON.stringify(ts)).not.toContain("ada@acme.com");
  });

  it("extracts from the webhook single-change shape (no histories wrapper)", () => {
    const ts = extractTransitions(
      { id: "555", items: [{ field: "status", fromString: "Open", toString: "Closed" }] },
      "ENG-9",
      "ENG",
      BASE,
    );
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ changeId: "555", fromStatus: "Open", toStatus: "Closed" });
  });

  it("ignores changes without a status item", () => {
    expect(
      extractTransitions(
        { histories: [{ id: "1", items: [{ field: "priority", toString: "High" }] }] },
        "ENG-1",
        "ENG",
        BASE,
      ),
    ).toEqual([]);
    expect(extractTransitions(null, "ENG-1", "ENG", BASE)).toEqual([]);
  });
});

describe("mapJiraEvent — transition + sprint", () => {
  it("maps a transition to jira.issue.transition", () => {
    const t: JiraTransition = {
      type: "transition",
      issueKey: "ENG-1",
      projectKey: "ENG",
      changeId: "100",
      fromStatus: "To Do",
      toStatus: "In Progress",
      author: "Bob R",
      occurredAt: "2026-03-01T00:00:00.000Z",
      url: `${BASE}/browse/ENG-1`,
    };
    const ep = mapJiraEvent(t);
    expect(ep.kind).toBe("jira.issue.transition");
    expect(ep.subject).toBe("project:ENG");
    expect(ep.text).toBe("Bob R moved ENG-1 from To Do to In Progress");
    expect(ep.metadata?.from_status).toBe("To Do");
    expect(ep.metadata?.to_status).toBe("In Progress");
    expect(ep.source.id).toBe("ENG-1/transition/100");
  });

  it("transition idempotency keys on the changelog id", () => {
    const mk = (changeId: string): string => {
      const t: JiraTransition = {
        type: "transition",
        issueKey: "ENG-1",
        projectKey: "ENG",
        changeId,
        fromStatus: "A",
        toStatus: "B",
        author: null,
        occurredAt: "2026-03-01T00:00:00.000Z",
        url: `${BASE}/browse/ENG-1`,
      };
      return mapJiraEvent(t).idempotency_key!;
    };
    expect(mk("100")).toBe(mk("100"));
    expect(mk("100")).not.toBe(mk("101"));
  });

  it("includes sprint context + sprint:<name> related subject on an issue", () => {
    const issue: JiraIssue = {
      type: "issue",
      key: "ENG-1",
      projectKey: "ENG",
      summary: "x",
      description: "",
      statusName: "To Do",
      statusCategory: "new",
      labels: [],
      assignee: null,
      reporter: null,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      resolutionDate: null,
      sprints: [{ id: 7, name: "Sprint 7", state: "active", boardId: 3 }],
      url: `${BASE}/browse/ENG-1`,
    };
    const ep = mapJiraEvent(issue);
    expect(ep.metadata?.sprints).toEqual([{ id: 7, name: "Sprint 7", state: "active", boardId: 3 }]);
    expect(ep.metadata?.related_subjects).toContain("sprint:Sprint 7");
  });
});

describe("JiraClient.searchIssuesDetailed (mocked fetch)", () => {
  function mockFetch(issuesPage: unknown): typeof fetch {
    return (async (url: string) => {
      void url;
      return new Response(JSON.stringify({ total: 1, issues: issuesPage }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("expands changelog + sprint field into issues and transitions (no extra calls)", async () => {
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      const issue = {
        key: "ENG-1",
        fields: {
          summary: "Login broken",
          status: { name: "Done", statusCategory: { key: "done" } },
          project: { key: "ENG" },
          customfield_10020: [{ id: 7, name: "Sprint 7", state: "active", boardId: 3 }],
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-03-02T00:00:00.000Z",
        },
        changelog: {
          histories: [
            {
              id: "100",
              created: "2026-03-02T00:00:00.000Z",
              author: { displayName: "Ada L" },
              items: [{ field: "status", fromString: "In Progress", toString: "Done" }],
            },
          ],
        },
      };
      return new Response(JSON.stringify({ total: 1, issues: [issue] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new JiraClient({
      baseUrl: BASE,
      email: "you@acme.com",
      apiToken: "tok",
      fetchImpl,
    });
    const { issues, transitions } = await client.searchIssuesDetailed({
      projects: ["ENG"],
      max: 50,
      expandChangelog: true,
      sprintField: "customfield_10020",
    });
    // Cloud now POSTs to /search/jql with expand/fields in the JSON body
    // (CHANGE-2046); they are no longer query-string params.
    expect(requestedUrl).toContain("/rest/api/3/search/jql");
    expect(requestedBody?.expand).toEqual(["changelog"]);
    expect(requestedBody?.fields).toContain("customfield_10020");
    expect(issues).toHaveLength(1);
    expect(issues[0]!.sprints).toEqual([{ id: 7, name: "Sprint 7", state: "active", boardId: 3 }]);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ issueKey: "ENG-1", fromStatus: "In Progress", toStatus: "Done" });
  });

  it("does not request changelog or custom fields when not asked", async () => {
    let requestedUrl = "";
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return new Response(JSON.stringify({ total: 0, issues: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: BASE, email: "e", apiToken: "t", fetchImpl });
    await client.searchIssuesDetailed({ projects: ["ENG"], max: 10 });
    expect(requestedUrl).not.toContain("expand=changelog");
    expect(requestedUrl).not.toContain("customfield");
    void mockFetch;
  });
});
