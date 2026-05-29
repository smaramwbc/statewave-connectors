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
import { GitlabClient, parseRepoRef } from "./client.js";
import { defaultSubject, mapGitlabEvent } from "./mapper.js";
import type { GitlabEvent, GitlabRepoRef } from "./types.js";

export interface GitlabConnectorConfig {
  repo: string | GitlabRepoRef;
  token?: string;
  subject?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["issues", "mrs", "comments", "approvals", "releases"] as const;
type GitlabKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createGitlabConnector(config: GitlabConnectorConfig): StatewaveConnector<
  GitlabConnectorConfig,
  GitlabEvent
> {
  const repo = typeof config.repo === "string" ? parseRepoRef(config.repo) : config.repo;
  const subject = config.subject ?? defaultSubject(repo);
  const client = new GitlabClient({ token: config.token, baseUrl: config.baseUrl, fetchImpl: config.fetchImpl });

  return {
    id: `gitlab:${repo.owner}/${repo.name}`,
    name: "GitLab",
    source: "gitlab",

    async configure(_next: GitlabConnectorConfig): Promise<void> {
      throw new ConnectorError("gitlab connector is configured at construction time", {
        code: "unsupported",
        connector: "gitlab",
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
            : "no GITLAB_TOKEN — public-only reads, lower rate limits",
        },
      ];
      return {
        connector: "gitlab",
        status: "ok",
        details,
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const events: GitlabEvent[] = [];

      // Comments are fetched per parent, so we may need to list issues/MRs even
      // when only "comments" is requested — to discover their iids.
      const needIssues = groups.has("issues") || groups.has("comments");
      const needMrs = groups.has("mrs") || groups.has("comments") || groups.has("approvals");

      if (needIssues) {
        const issues = await client.listIssues(repo, { since });
        for (const issue of issues) {
          if (groups.has("issues")) events.push(issue);
          if (groups.has("comments")) {
            const notes = await client.listNotes(repo, {
              kind: "issue",
              iid: issue.iid,
              web_url: issue.web_url,
            });
            for (const n of notes) events.push(n);
          }
        }
      }

      if (needMrs) {
        const mrs = await client.listMergeRequests(repo, { since });
        for (const mr of mrs) {
          if (groups.has("mrs")) events.push(mr);
          if (groups.has("comments")) {
            const notes = await client.listNotes(repo, {
              kind: "merge_request",
              iid: mr.iid,
              web_url: mr.web_url,
            });
            for (const n of notes) events.push(n);
          }
          if (groups.has("approvals")) {
            const approvals = await client.listMergeRequestApprovals(repo, {
              iid: mr.iid,
              web_url: mr.web_url,
              updated_at: mr.updated_at,
            });
            for (const a of approvals) events.push(a);
          }
        }
      }

      if (groups.has("releases")) {
        const releases = await client.listReleases(repo);
        for (const r of releases) {
          if (since && new Date(r.released_at) < new Date(since)) continue;
          events.push(r);
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapGitlabEvent(ev, { repo, subject: options.subject ?? subject });
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
        connector: "gitlab",
        source: "gitlab",
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

    async mapEvent(event: GitlabEvent): Promise<StatewaveEpisode> {
      return mapGitlabEvent(event, { repo, subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<GitlabKindGroup> {
  const base = new Set<GitlabKindGroup>(include?.length ? (include as GitlabKindGroup[]) : DEFAULT_INCLUDE);
  if (exclude) for (const e of exclude) base.delete(e as GitlabKindGroup);
  return base;
}

function countEventsBySourceType(events: ReadonlyArray<GitlabEvent>): Record<string, number> {
  let issues = 0;
  let mrs = 0;
  let issueComments = 0;
  let mrComments = 0;
  let approvals = 0;
  let releases = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "issue":
        issues += 1;
        break;
      case "merge_request":
        mrs += 1;
        break;
      case "note":
        if (ev.parent === "merge_request") mrComments += 1;
        else issueComments += 1;
        break;
      case "approval":
        approvals += 1;
        break;
      case "release":
        releases += 1;
        break;
    }
  }
  return {
    events_issues: issues,
    events_mrs: mrs,
    events_issue_comments: issueComments,
    events_mr_comments: mrComments,
    events_approvals: approvals,
    events_releases: releases,
  };
}
