import { describe, it, expect } from "vitest";
import { defaultSubject, mapN8nEvent } from "../src/index.js";
import type { N8nExecution, N8nWorkflow } from "../src/index.js";

const workflow: N8nWorkflow = { id: "1", name: "Daily ETL", active: true };

function execution(overrides: Partial<N8nExecution> = {}): N8nExecution {
  return {
    id: "exec-100",
    workflowId: "1",
    status: "success",
    finished: true,
    mode: "trigger",
    startedAt: "2026-05-08T10:00:00.000Z",
    stoppedAt: "2026-05-08T10:00:02.500Z",
    ...overrides,
  };
}

describe("n8n mapper", () => {
  it("uses workflow:<id> as the default subject", () => {
    expect(defaultSubject(workflow)).toBe("workflow:1");
  });

  it("maps a successful execution to n8n.workflow.executed", () => {
    const ep = mapN8nEvent(
      { type: "execution", workflow, execution: execution() },
      { workflow, baseUrl: "https://n8n.example.com" },
    );
    expect(ep.subject).toBe("workflow:1");
    expect(ep.kind).toBe("n8n.workflow.executed");
    expect(ep.text).toContain("Daily ETL");
    expect(ep.text).toContain("completed");
    expect(ep.source.id).toBe("1:exec-100");
    expect(ep.source.url).toBe("https://n8n.example.com/workflow/executions/exec-100");
    expect(ep.metadata?.execution_status).toBe("success");
  });

  it("maps a failed execution to n8n.workflow.failed and surfaces the error message", () => {
    const ep = mapN8nEvent(
      {
        type: "execution",
        workflow,
        execution: execution({
          status: "error",
          data: { resultData: { error: { message: "rate limit hit" } } },
        }),
      },
      { workflow },
    );
    expect(ep.kind).toBe("n8n.workflow.failed");
    expect(ep.text).toContain("rate limit hit");
    expect(ep.metadata?.error_message).toBe("rate limit hit");
  });

  it("maps a per-node error to n8n.node.errored", () => {
    const ep = mapN8nEvent(
      {
        type: "node_error",
        workflow,
        execution: execution({ status: "error" }),
        node_name: "HTTP Request",
        error: { message: "connect ETIMEDOUT" },
      },
      { workflow },
    );
    expect(ep.kind).toBe("n8n.node.errored");
    expect(ep.text).toContain('Node "HTTP Request"');
    expect(ep.text).toContain("connect ETIMEDOUT");
    expect(ep.source.id).toBe("1:exec-100:HTTP Request");
    expect(ep.metadata?.node_name).toBe("HTTP Request");
  });

  it("respects a caller-supplied subject", () => {
    const ep = mapN8nEvent(
      { type: "execution", workflow, execution: execution() },
      { workflow, subject: "customer:acme" },
    );
    expect(ep.subject).toBe("customer:acme");
  });

  it("produces deterministic idempotency keys for the same execution", () => {
    const a = mapN8nEvent(
      { type: "execution", workflow, execution: execution() },
      { workflow },
    );
    const b = mapN8nEvent(
      { type: "execution", workflow, execution: execution() },
      { workflow },
    );
    expect(a.idempotency_key).toBe(b.idempotency_key);
  });

  it("uses occurred_at = stoppedAt when present, else startedAt", () => {
    const stopped = mapN8nEvent(
      { type: "execution", workflow, execution: execution() },
      { workflow },
    );
    expect(stopped.occurred_at).toBe("2026-05-08T10:00:02.500Z");

    const inflight = mapN8nEvent(
      { type: "execution", workflow, execution: execution({ stoppedAt: null, finished: false }) },
      { workflow },
    );
    expect(inflight.occurred_at).toBe("2026-05-08T10:00:00.000Z");
  });
});
