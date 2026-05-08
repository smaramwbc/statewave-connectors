// n8n-execution → Statewave-episode mapping. Side-effect-free; the connector
// extracts per-node errors from the execution envelope before calling this
// mapper, so there's a single dispatch on `event.type` here rather than a
// custom traversal of the runData blob.

import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  N8nEvent,
  N8nEventKind,
  N8nExecutionEnvelope,
  N8nNodeErrorEnvelope,
  N8nWorkflow,
} from "./types.js";

export interface MapperOptions {
  workflow: N8nWorkflow;
  /** Override for the default `workflow:<id>` subject. */
  subject?: string;
  /** Base URL of the n8n instance — used to build `source.url` deep-links. */
  baseUrl?: string;
}

export function defaultSubject(workflow: N8nWorkflow): string {
  return `workflow:${workflow.id}`;
}

export function mapN8nEvent(event: N8nEvent, options: MapperOptions): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(options.workflow);
  switch (event.type) {
    case "execution":
      return mapExecution(event, { ...options, subject });
    case "node_error":
      return mapNodeError(event, { ...options, subject });
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported n8n event type", {
        code: "mapping_failed",
        connector: "n8n",
      });
    }
  }
}

function mapExecution(
  event: N8nExecutionEnvelope & { type: "execution" },
  options: Required<Pick<MapperOptions, "subject">> & MapperOptions,
): StatewaveEpisode {
  const { execution, workflow } = event;
  const failed = execution.status === "error" || execution.status === "crashed";
  const kind: N8nEventKind = failed ? "n8n.workflow.failed" : "n8n.workflow.executed";
  const occurred = execution.stoppedAt ?? execution.startedAt;
  const errorMessage = execution.data?.resultData?.error?.message;

  const headline = failed
    ? `Workflow "${workflow.name ?? workflow.id}" failed: ${errorMessage ?? execution.status}`
    : `Workflow "${workflow.name ?? workflow.id}" completed (${execution.status})`;
  const text = `${headline} [execution=${execution.id} mode=${execution.mode} duration=${formatDuration(execution.startedAt, execution.stoppedAt)}]`;

  const builder = new EpisodeBuilder({
    subject: options.subject,
    metadata: baseMetadata(workflow),
  });
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "n8n.execution",
      id: `${workflow.id}:${execution.id}`,
      url: deepLinkExecution(options.baseUrl, execution.id),
    },
    metadata: {
      execution_id: execution.id,
      execution_mode: execution.mode,
      execution_status: execution.status,
      finished: execution.finished,
      started_at: execution.startedAt,
      stopped_at: execution.stoppedAt ?? null,
      error_message: errorMessage ?? null,
    },
    idempotency_parts: ["n8n", workflow.id, "execution", execution.id, kind],
  });
}

function mapNodeError(
  event: N8nNodeErrorEnvelope & { type: "node_error" },
  options: Required<Pick<MapperOptions, "subject">> & MapperOptions,
): StatewaveEpisode {
  const { execution, workflow, node_name, error } = event;
  const text = `Node "${node_name}" failed in workflow "${workflow.name ?? workflow.id}": ${error.message} [execution=${execution.id}]`;

  const builder = new EpisodeBuilder({
    subject: options.subject,
    metadata: baseMetadata(workflow),
  });
  return builder.build({
    kind: "n8n.node.errored",
    text,
    occurred_at: execution.stoppedAt ?? execution.startedAt,
    source: {
      type: "n8n.node_error",
      id: `${workflow.id}:${execution.id}:${node_name}`,
      url: deepLinkExecution(options.baseUrl, execution.id),
    },
    metadata: {
      execution_id: execution.id,
      node_name,
      error_name: error.name ?? null,
      error_description: error.description ?? null,
    },
    idempotency_parts: ["n8n", workflow.id, "node_error", execution.id, node_name],
  });
}

function baseMetadata(workflow: N8nWorkflow): Record<string, unknown> {
  return {
    workflow_id: workflow.id,
    workflow_name: workflow.name,
    workflow_active: workflow.active,
  };
}

function deepLinkExecution(baseUrl: string | undefined, executionId: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/$/, "")}/workflow/executions/${executionId}`;
}

function formatDuration(startedAt: string, stoppedAt?: string | null): string {
  if (!stoppedAt) return "in_progress";
  const ms = new Date(stoppedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}
