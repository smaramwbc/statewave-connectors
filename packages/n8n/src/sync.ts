// `createN8nConnector` — pull-mode source connector for n8n. Lists
// executions for one or more workflows, extracts per-node errors, and emits
// `n8n.workflow.executed` / `n8n.workflow.failed` / `n8n.node.errored`
// episodes under `workflow:<id>` (or a caller-supplied subject).

import {
  ConnectorError,
  redactEpisodeText,
  summarizeEpisodes,
  type ConnectorCheckResult,
  type StatewaveConnector,
  type StatewaveEpisode,
  type SyncOptions,
  type SyncResult,
} from "@statewavedev/connectors-core";
import { N8nClient, type N8nClientOptions } from "./client.js";
import { defaultSubject, mapN8nEvent } from "./mapper.js";
import type { N8nEvent, N8nExecution, N8nWorkflow } from "./types.js";

export interface N8nConnectorConfig {
  /** Base URL of the n8n instance (e.g. `https://n8n.example.com`). */
  baseUrl: string;
  /** API key (`X-N8N-API-KEY`). Required. */
  apiKey: string;
  /**
   * Workflow selectors — either ids or names. At least one is required so
   * we don't accidentally walk every execution in the instance on first run.
   */
  workflows: ReadonlyArray<string>;
  /** Override the default `workflow:<id>` subject. */
  subject?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["executions", "node_errors"] as const;
type N8nKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createN8nConnector(
  config: N8nConnectorConfig,
): StatewaveConnector<N8nConnectorConfig, N8nEvent> {
  if (!config.workflows || config.workflows.length === 0) {
    throw new ConnectorError(
      "the n8n connector requires at least one workflow — pass --workflows <id-or-name>[,…]",
      {
        code: "config_invalid",
        connector: "n8n",
        hint: "ingesting every execution in an instance by default would be expensive and surprising",
      },
    );
  }

  const clientOptions: N8nClientOptions = {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    fetchImpl: config.fetchImpl,
  };
  const client = new N8nClient(clientOptions);

  // Cache the resolved workflow directory across `check()` and `sync()`.
  let workflowDirectory: ReadonlyMap<string, N8nWorkflow> | undefined;
  let resolved: ReadonlyArray<N8nWorkflow> | undefined;

  async function ensureDirectory(): Promise<ReadonlyMap<string, N8nWorkflow>> {
    if (workflowDirectory) return workflowDirectory;
    const all = await client.listWorkflows();
    workflowDirectory = new Map(all.map((w) => [w.id, w]));
    return workflowDirectory;
  }

  async function ensureWorkflows(): Promise<ReadonlyArray<N8nWorkflow>> {
    if (resolved) return resolved;
    const directory = await ensureDirectory();
    const byName = new Map<string, N8nWorkflow>();
    for (const w of directory.values()) {
      if (w.name) byName.set(w.name, w);
    }
    const out: N8nWorkflow[] = [];
    const missing: string[] = [];
    for (const sel of config.workflows) {
      const direct = directory.get(sel);
      if (direct) {
        out.push(direct);
        continue;
      }
      const named = byName.get(sel);
      if (named) {
        out.push(named);
        continue;
      }
      missing.push(sel);
    }
    if (missing.length > 0) {
      throw new ConnectorError(`n8n: workflows not found in instance: ${missing.join(", ")}`, {
        code: "not_found",
        connector: "n8n",
        hint: "use the workflow id (visible in the n8n URL) or its exact name",
      });
    }
    resolved = out;
    return out;
  }

  return {
    id: `n8n:${config.workflows.join(",")}`,
    name: "n8n",
    source: "n8n",

    async configure(_next: N8nConnectorConfig): Promise<void> {
      throw new ConnectorError("n8n connector is configured at construction time", {
        code: "unsupported",
        connector: "n8n",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details: Array<{ name: string; status: "ok" | "warn" | "error"; message?: string }> = [];
      let status: "ok" | "warn" | "error" = "ok";
      try {
        await client.ping();
        details.push({ name: "auth", status: "ok", message: "ok" });
      } catch (err) {
        status = "error";
        details.push({
          name: "auth",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        return { connector: "n8n", status, details };
      }
      try {
        const workflows = await ensureWorkflows();
        details.push({
          name: "workflows",
          status: "ok",
          message: workflows.map((w) => w.name ?? w.id).join(", "),
        });
      } catch (err) {
        status = "error";
        details.push({
          name: "workflows",
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { connector: "n8n", status, details };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const workflows = await ensureWorkflows();
      const since = options.since ? new Date(options.since).toISOString() : undefined;

      const events: N8nEvent[] = [];
      for (const workflow of workflows) {
        const executions = await client.listExecutions(workflow.id, { since });
        for (const execution of executions) {
          if (groups.has("executions")) {
            events.push({ type: "execution", workflow, execution });
          }
          if (groups.has("node_errors")) {
            for (const ev of extractNodeErrors(workflow, execution)) {
              events.push(ev);
            }
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const subject = options.subject ?? config.subject ?? defaultSubject(ev.workflow);
        const ep = mapN8nEvent(ev, {
          workflow: ev.workflow,
          subject,
          baseUrl: config.baseUrl,
        });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const executionsCount = limited.filter((e) => e.type === "execution").length;
      const nodeErrorsCount = limited.length - executionsCount;
      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        events_executions: executionsCount,
        events_node_errors: nodeErrorsCount,
        workflows_synced: workflows.length,
      };

      return {
        connector: "n8n",
        source: "n8n",
        subject: options.subject ?? config.subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: N8nEvent): Promise<StatewaveEpisode> {
      return mapN8nEvent(event, {
        workflow: event.workflow,
        subject: config.subject ?? defaultSubject(event.workflow),
        baseUrl: config.baseUrl,
      });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<N8nKindGroup> {
  const base = new Set<N8nKindGroup>(
    include?.length ? (include as N8nKindGroup[]) : DEFAULT_INCLUDE,
  );
  if (exclude) for (const e of exclude) base.delete(e as N8nKindGroup);
  return base;
}

/**
 * Walk the `runData` blob attached to an execution and emit one
 * `node_error` event per failed node. n8n's runData is a map of
 * `node_name` → `runs[]` where each run can carry an `error` envelope; a
 * node may have multiple runs (e.g. retries) so we emit one episode per
 * errored run, distinguished by node name + execution id at the
 * idempotency layer.
 */
function extractNodeErrors(workflow: N8nWorkflow, execution: N8nExecution): N8nEvent[] {
  const runData = execution.data?.resultData?.runData;
  if (!runData) return [];
  const events: N8nEvent[] = [];
  for (const [node_name, runs] of Object.entries(runData)) {
    for (const run of runs) {
      if (!run.error) continue;
      const message = run.error.message ?? "(no message)";
      events.push({
        type: "node_error",
        workflow,
        execution,
        node_name,
        error: {
          message,
          name: run.error.name,
          description: run.error.description,
        },
      });
    }
  }
  return events;
}
