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
import { GiteaClient, parseRepoRef } from "./client.js";
import { defaultSubject, mapGiteaEvent } from "./mapper.js";
import type { GiteaEvent, GiteaRepoRef } from "./types.js";

export interface GiteaConnectorConfig {
  repo: string | GiteaRepoRef;
  token?: string;
  subject?: string;
  /** Self-hosted Gitea / Forgejo base URL, e.g. https://gitea.example.com. Required. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["issues", "prs", "comments", "reviews", "releases"] as const;
type GiteaKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createGiteaConnector(config: GiteaConnectorConfig): StatewaveConnector<
  GiteaConnectorConfig,
  GiteaEvent
> {
  const repo = typeof config.repo === "string" ? parseRepoRef(config.repo) : config.repo;
  const subject = config.subject ?? defaultSubject(repo);
  const client = new GiteaClient({
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  });

  return {
    id: `gitea:${repo.owner}/${repo.name}`,
    name: "Gitea",
    source: "gitea",

    async configure(_next: GiteaConnectorConfig): Promise<void> {
      throw new ConnectorError("gitea connector is configured at construction time", {
        code: "unsupported",
        connector: "gitea",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      const details = [
        {
          name: "repo",
          status: "ok" as const,
          message: `${repo.owner}/${repo.name}`,
        },
        {
          name: "host",
          status: "ok" as const,
          message: config.baseUrl,
        },
        {
          name: "auth",
          status: (config.token ? "ok" : "warn") as "ok" | "warn",
          message: config.token
            ? "authenticated"
            : "no GITEA_TOKEN — public-only reads, lower rate limits",
        },
      ];
      return {
        connector: "gitea",
        status: "ok",
        details,
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const sinceDate = since ? new Date(since) : undefined;
      const events: GiteaEvent[] = [];

      if (groups.has("issues")) {
        const issues = await client.listIssues(repo);
        for (const it of issues) {
          if (sinceDate && new Date(it.updated_at) < sinceDate) continue;
          events.push(it);
        }
      }

      if (groups.has("prs")) {
        const prs = await client.listPulls(repo);
        for (const pr of prs) {
          if (sinceDate && new Date(pr.updated_at) < sinceDate) continue;
          events.push(pr);
          if (groups.has("reviews")) {
            const reviews = await client.listPrReviews(repo, pr.number);
            for (const r of reviews) events.push(r);
          }
        }
      }

      if (groups.has("comments")) {
        const comments = await client.listIssueComments(repo, { since });
        for (const c of comments) events.push(c);
      }

      if (groups.has("releases")) {
        const releases = await client.listReleases(repo);
        for (const r of releases) {
          if (sinceDate && new Date(r.published_at) < sinceDate) continue;
          events.push(r);
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapGiteaEvent(ev, { repo, subject: options.subject ?? subject });
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
        connector: "gitea",
        source: "gitea",
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

    async mapEvent(event: GiteaEvent): Promise<StatewaveEpisode> {
      return mapGiteaEvent(event, { repo, subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<GiteaKindGroup> {
  const base = new Set<GiteaKindGroup>(include?.length ? (include as GiteaKindGroup[]) : DEFAULT_INCLUDE);
  if (exclude) for (const e of exclude) base.delete(e as GiteaKindGroup);
  return base;
}

function countEventsBySourceType(events: ReadonlyArray<GiteaEvent>): Record<string, number> {
  let issues = 0;
  let prs = 0;
  let issueComments = 0;
  let prComments = 0;
  let prReviews = 0;
  let releases = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "issue":
        issues += 1;
        break;
      case "pull_request":
        prs += 1;
        break;
      case "comment":
        if (ev.parent === "pull_request") prComments += 1;
        else issueComments += 1;
        break;
      case "review":
        prReviews += 1;
        break;
      case "release":
        releases += 1;
        break;
    }
  }
  return {
    events_issues: issues,
    events_prs: prs,
    events_issue_comments: issueComments,
    events_pr_comments: prComments,
    events_pr_reviews: prReviews,
    events_releases: releases,
  };
}
