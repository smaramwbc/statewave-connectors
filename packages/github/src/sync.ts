import {
  ConnectorError,
  redactEpisodeText,
  summarizeEpisodes,
  type ConnectorCheckResult,
  type StatewaveConnector,
  type StatewaveEpisode,
  type SyncOptions,
  type SyncResult,
} from "@statewave/connectors-core";
import { GithubClient, parseRepoRef } from "./client.js";
import { defaultSubject, mapGithubEvent } from "./mapper.js";
import type { GithubEvent, GithubRepoRef } from "./types.js";

export interface GithubConnectorConfig {
  repo: string | GithubRepoRef;
  token?: string;
  subject?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["issues", "prs", "comments", "reviews", "releases"] as const;
type GithubKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createGithubConnector(config: GithubConnectorConfig): StatewaveConnector<
  GithubConnectorConfig,
  GithubEvent
> {
  const repo = typeof config.repo === "string" ? parseRepoRef(config.repo) : config.repo;
  const subject = config.subject ?? defaultSubject(repo);
  const client = new GithubClient({ token: config.token, baseUrl: config.baseUrl, fetchImpl: config.fetchImpl });

  return {
    id: `github:${repo.owner}/${repo.name}`,
    name: "GitHub",
    source: "github",

    async configure(_next: GithubConnectorConfig): Promise<void> {
      throw new ConnectorError("github connector is configured at construction time", {
        code: "unsupported",
        connector: "github",
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
          name: "auth",
          status: (config.token ? "ok" : "warn") as "ok" | "warn",
          message: config.token
            ? "authenticated"
            : "no GITHUB_TOKEN — public-only reads, lower rate limits",
        },
      ];
      return {
        connector: "github",
        status: "ok",
        details,
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const events: GithubEvent[] = [];

      if (groups.has("issues") || groups.has("prs")) {
        const items = await client.listIssuesAndPrs(repo, { since });
        for (const it of items) {
          if (it.type === "issue" && groups.has("issues")) events.push(it);
          if (it.type === "pull_request" && groups.has("prs")) {
            events.push(it);
            if (groups.has("reviews")) {
              const reviews = await client.listPrReviews(repo, it.number);
              for (const r of reviews) events.push(r);
            }
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
          if (since && new Date(r.published_at) < new Date(since)) continue;
          events.push(r);
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapGithubEvent(ev, { repo, subject: options.subject ?? subject });
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
        connector: "github",
        source: "github",
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

    async mapEvent(event: GithubEvent): Promise<StatewaveEpisode> {
      return mapGithubEvent(event, { repo, subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<GithubKindGroup> {
  const base = new Set<GithubKindGroup>(include?.length ? (include as GithubKindGroup[]) : DEFAULT_INCLUDE);
  if (exclude) for (const e of exclude) base.delete(e as GithubKindGroup);
  return base;
}

function countEventsBySourceType(events: ReadonlyArray<GithubEvent>): Record<string, number> {
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
