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
import { AzureClient, parseRepoRef } from "./client.js";
import { defaultSubject, mapAzureEvent } from "./mapper.js";
import type { AzureEvent, AzureRepoRef } from "./types.js";

export interface AzureDevOpsConnectorConfig {
  repo: string | AzureRepoRef;
  token?: string;
  subject?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["prs", "comments", "reviews", "workitems"] as const;
type AzureKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createAzureDevOpsConnector(config: AzureDevOpsConnectorConfig): StatewaveConnector<
  AzureDevOpsConnectorConfig,
  AzureEvent
> {
  const repo = typeof config.repo === "string" ? parseRepoRef(config.repo) : config.repo;
  const subject = config.subject ?? defaultSubject(repo);
  const client = new AzureClient({
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  });
  const id = `azure-devops:${repo.organization}/${repo.project}/${repo.repository}`;

  return {
    id,
    name: "Azure DevOps",
    source: "azure-devops",

    async configure(_next: AzureDevOpsConnectorConfig): Promise<void> {
      throw new ConnectorError("azure devops connector is configured at construction time", {
        code: "unsupported",
        connector: "azure-devops",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details = [
        {
          name: "repo",
          status: "ok" as const,
          message: `${repo.organization}/${repo.project}/${repo.repository}`,
        },
        {
          name: "auth",
          status: (config.token ? "ok" : "warn") as "ok" | "warn",
          message: config.token
            ? "authenticated"
            : "no AZURE_DEVOPS_PAT — private repos and work items will 401",
        },
      ];
      return {
        connector: "azure-devops",
        status: "ok",
        details,
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const sinceMs = since ? new Date(since).getTime() : undefined;
      const events: AzureEvent[] = [];

      if (groups.has("prs") || groups.has("comments") || groups.has("reviews")) {
        const prs = await client.listPullRequests(repo);
        for (const pr of prs) {
          const refDate = pr.closedDate ?? pr.creationDate;
          if (sinceMs !== undefined && new Date(refDate).getTime() < sinceMs) continue;
          if (groups.has("prs")) events.push(pr);
          if (groups.has("comments")) {
            const comments = await client.listPrComments(repo, pr.pullRequestId);
            for (const c of comments) events.push(c);
          }
          if (groups.has("reviews")) {
            const reviews = client.reviewsFromPr(pr);
            for (const r of reviews) events.push(r);
          }
        }
      }

      if (groups.has("workitems")) {
        const items = await client.listWorkItems(repo, { since });
        for (const it of items) events.push(it);
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapAzureEvent(ev, { repo, subject: options.subject ?? subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      // Per-event-type pre-truncation counts make it obvious when --max-items
      // dropped half of the run. The post-mapping kind histogram lives on
      // summary.kinds; details captures the source-side breakdown.
      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        ...countEventsBySourceType(events),
      };

      return {
        connector: "azure-devops",
        source: "azure-devops",
        subject: options.subject ?? subject,
        episodes,
        ingested,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: AzureEvent): Promise<StatewaveEpisode> {
      return mapAzureEvent(event, { repo, subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<AzureKindGroup> {
  const base = new Set<AzureKindGroup>(
    include?.length ? (include as AzureKindGroup[]) : DEFAULT_INCLUDE,
  );
  if (exclude) for (const e of exclude) base.delete(e as AzureKindGroup);
  return base;
}

function countEventsBySourceType(events: ReadonlyArray<AzureEvent>): Record<string, number> {
  let prs = 0;
  let prComments = 0;
  let prReviews = 0;
  let workitems = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "pull_request":
        prs += 1;
        break;
      case "comment":
        prComments += 1;
        break;
      case "review":
        prReviews += 1;
        break;
      case "work_item":
        workitems += 1;
        break;
    }
  }
  return {
    events_prs: prs,
    events_pr_comments: prComments,
    events_pr_reviews: prReviews,
    events_workitems: workitems,
  };
}
