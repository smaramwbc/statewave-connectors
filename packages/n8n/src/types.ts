// Public types for the n8n connector. We model the shape of n8n's REST API
// (`/api/v1/executions`) at the granularity the v0.1 mapper actually reads.
// Unmodeled fields fall on the floor — the n8n surface is large and most of
// it is workflow-builder configuration, not runtime signal.

export type N8nEventKind =
  | "n8n.workflow.executed"
  | "n8n.workflow.failed"
  | "n8n.node.errored";

export type N8nExecutionStatus =
  | "success"
  | "error"
  | "canceled"
  | "crashed"
  | "running"
  | "waiting";

/** Minimal workflow descriptor used to render a friendly title/subject. */
export interface N8nWorkflow {
  id: string;
  name?: string;
  active?: boolean;
}

/**
 * One workflow execution returned by `GET /api/v1/executions`. n8n's API
 * includes the per-node `runData` blob optionally — when present, the
 * mapper extracts per-node failures into separate episodes.
 */
export interface N8nExecution {
  id: string;
  workflowId: string;
  status: N8nExecutionStatus;
  finished: boolean;
  mode: string;
  startedAt: string;
  stoppedAt?: string | null;
  /**
   * Present when `?includeData=true` was passed. We model only the
   * resultData branch the mapper consumes.
   */
  data?: {
    resultData?: {
      runData?: Record<string, ReadonlyArray<N8nNodeRun>>;
      error?: { message?: string; name?: string; description?: string } | null;
    };
  };
}

export interface N8nNodeRun {
  startTime?: number;
  executionTime?: number;
  /** When the node failed, n8n attaches an error envelope here. */
  error?: {
    message?: string;
    name?: string;
    description?: string;
    node?: { name?: string; type?: string };
  };
}

/** A normalized event the mapper consumes — either a whole-execution result
 * or a per-node error extracted from one. */
export type N8nEvent =
  | (N8nExecutionEnvelope & { type: "execution" })
  | (N8nNodeErrorEnvelope & { type: "node_error" });

export interface N8nExecutionEnvelope {
  workflow: N8nWorkflow;
  execution: N8nExecution;
}

export interface N8nNodeErrorEnvelope {
  workflow: N8nWorkflow;
  execution: N8nExecution;
  node_name: string;
  error: { message: string; name?: string; description?: string };
}
