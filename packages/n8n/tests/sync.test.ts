import { describe, it, expect } from "vitest";
import { ConnectorError } from "@statewavedev/connectors-core";
import { createN8nConnector } from "../src/index.js";

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
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const WORKFLOWS_LIST = {
  data: [
    { id: "1", name: "Daily ETL", active: true },
    { id: "2", name: "Slack alerts", active: true },
  ],
};

describe("createN8nConnector", () => {
  it("requires at least one workflow", () => {
    expect(() =>
      createN8nConnector({
        baseUrl: "https://n8n.example.com",
        apiKey: "test",
        workflows: [],
      }),
    ).toThrow(ConnectorError);
  });

  it("requires an apiKey", () => {
    expect(() =>
      createN8nConnector({
        baseUrl: "https://n8n.example.com",
        apiKey: "",
        workflows: ["1"],
      }),
    ).toThrow(ConnectorError);
  });

  it("syncs executions + extracts per-node errors from runData", async () => {
    const fetchImpl = fakeFetch({
      "/api/v1/workflows": { body: WORKFLOWS_LIST },
      "/api/v1/executions": {
        body: {
          data: [
            {
              id: "exec-200",
              workflowId: "1",
              status: "error",
              finished: true,
              mode: "manual",
              startedAt: "2026-05-08T10:00:00.000Z",
              stoppedAt: "2026-05-08T10:00:01.000Z",
              data: {
                resultData: {
                  error: { message: "Workflow failed" },
                  runData: {
                    "HTTP Request": [
                      {
                        startTime: 1700000000,
                        executionTime: 500,
                        error: { message: "connect ETIMEDOUT", name: "ConnectError" },
                      },
                    ],
                    Postgres: [{ startTime: 1700000001, executionTime: 0 }],
                  },
                },
              },
            },
            {
              id: "exec-100",
              workflowId: "1",
              status: "success",
              finished: true,
              mode: "trigger",
              startedAt: "2026-05-07T09:00:00.000Z",
              stoppedAt: "2026-05-07T09:00:02.000Z",
            },
          ],
        },
      },
    });

    const connector = createN8nConnector({
      baseUrl: "https://n8n.example.com",
      apiKey: "test-api-key",
      workflows: ["1"],
      fetchImpl,
    });

    const result = await connector.sync({ dryRun: true });
    expect(result.connector).toBe("n8n");
    // 2 executions + 1 per-node error = 3 episodes.
    expect(result.episodes.length).toBe(3);

    const kinds = result.episodes.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "n8n.node.errored",
      "n8n.workflow.executed",
      "n8n.workflow.failed",
    ]);

    expect(result.summary.details?.events_executions).toBe(2);
    expect(result.summary.details?.events_node_errors).toBe(1);
    expect(result.summary.details?.workflows_synced).toBe(1);
  });

  it("resolves workflows by name as well as id", async () => {
    const fetchImpl = fakeFetch({
      "/api/v1/workflows": { body: WORKFLOWS_LIST },
      "/api/v1/executions": { body: { data: [] } },
    });
    const connector = createN8nConnector({
      baseUrl: "https://n8n.example.com",
      apiKey: "test",
      workflows: ["Daily ETL"],
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true });
    expect(result.summary.details?.workflows_synced).toBe(1);
  });

  it("errors loudly when a selector matches no workflow", async () => {
    const fetchImpl = fakeFetch({
      "/api/v1/workflows": { body: WORKFLOWS_LIST },
    });
    const connector = createN8nConnector({
      baseUrl: "https://n8n.example.com",
      apiKey: "test",
      workflows: ["nope-not-here"],
      fetchImpl,
    });
    await expect(connector.sync({ dryRun: true })).rejects.toMatchObject({
      message: expect.stringContaining("workflows not found"),
    });
  });

  it("respects --max-items by capping mapped episodes", async () => {
    const fetchImpl = fakeFetch({
      "/api/v1/workflows": { body: WORKFLOWS_LIST },
      "/api/v1/executions": {
        body: {
          data: Array.from({ length: 5 }, (_, i) => ({
            id: `exec-${i}`,
            workflowId: "1",
            status: "success",
            finished: true,
            mode: "trigger",
            startedAt: `2026-05-0${i + 1}T00:00:00.000Z`,
            stoppedAt: `2026-05-0${i + 1}T00:00:01.000Z`,
          })),
        },
      },
    });
    const connector = createN8nConnector({
      baseUrl: "https://n8n.example.com",
      apiKey: "test",
      workflows: ["1"],
      fetchImpl,
    });
    const result = await connector.sync({ dryRun: true, maxItems: 2 });
    expect(result.episodes.length).toBe(2);
    expect(result.skipped).toBe(3);
  });

  it("surfaces 401 as auth_failed in check()", async () => {
    const fetchImpl = fakeFetch({
      "/api/v1/workflows": { body: { error: "unauthorized" }, status: 401 },
    });
    const connector = createN8nConnector({
      baseUrl: "https://n8n.example.com",
      apiKey: "bad",
      workflows: ["1"],
      fetchImpl,
    });
    const check = await connector.check();
    expect(check.status).toBe("error");
    expect(check.details[0].name).toBe("auth");
  });
});
