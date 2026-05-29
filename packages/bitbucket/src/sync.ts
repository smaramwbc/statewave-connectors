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
import { BitbucketClient, parseRepoRef } from "./client.js";
import { defaultSubject, mapBitbucketEvent } from "./mapper.js";
import type { BitbucketEvent, BitbucketRepoRef } from "./types.js";

export interface BitbucketConnectorConfig {
  repo: string | BitbucketRepoRef;
  token?: string;
  subject?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["issues", "prs", "comments"] as const;
type BitbucketKindGroup = (typeof DEFAULT_INCLUDE)[number];

export function createBitbucketConnector(config: BitbucketConnectorConfig): StatewaveConnector<
  BitbucketConnectorConfig,
  BitbucketEvent
> {
  const repo = typeof config.repo === "string" ? parseRepoRef(config.repo) : config.repo;
  const subject = config.subject ?? defaultSubject(repo);
  const client = new BitbucketClient({
    token: config.token,
    baseUrl: config.baseUrl,
    fetchImpl: config.fetchImpl,
  });

  return {
    id: `bitbucket:${repo.owner}/${repo.name}`,
    name: "Bitbucket",
    source: "bitbucket",

    async configure(_next: BitbucketConnectorConfig): Promise<void> {
      throw new ConnectorError("bitbucket connector is configured at construction time", {
        code: "unsupported",
        connector: "bitbucket",
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
            : "no BITBUCKET_TOKEN — public-only reads, lower rate limits",
        },
      ];
      return {
        connector: "bitbucket",
        status: "ok",
        details,
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const events: BitbucketEvent[] = [];

      // PRs are fetched whenever PRs themselves OR their comments are requested,
      // since comments are fetched per-PR by id.
      const needPrs = groups.has("prs") || groups.has("comments");
      if (needPrs) {
        const prs = await client.listPullRequests(repo, { since });
        for (const pr of prs) {
          if (since && new Date(pr.updated_at) < new Date(since)) continue;
          if (groups.has("prs")) events.push(pr);
          if (groups.has("comments")) {
            const comments = await client.listPrComments(repo, pr.id, { since });
            for (const c of comments) {
              if (since && new Date(c.updated_at) < new Date(since)) continue;
              events.push(c);
            }
          }
        }
      }

      // Issues are fetched whenever issues themselves OR their comments are
      // requested, since comments are fetched per-issue by id.
      const needIssues = groups.has("issues") || groups.has("comments");
      if (needIssues) {
        // listIssues swallows a 404 (issue tracker disabled) and returns [].
        const issues = await client.listIssues(repo, { since });
        for (const it of issues) {
          if (since && new Date(it.updated_at) < new Date(since)) continue;
          if (groups.has("issues")) events.push(it);
          if (groups.has("comments")) {
            // listIssueComments swallows a per-issue/tracker 404 and returns [].
            const comments = await client.listIssueComments(repo, it.id, { since });
            for (const c of comments) {
              if (since && new Date(c.updated_at) < new Date(since)) continue;
              events.push(c);
            }
          }
        }
      }

      const max = options.maxItems ?? Number.POSITIVE_INFINITY;
      const limited = events.slice(0, max);

      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapBitbucketEvent(ev, { repo, subject: options.subject ?? subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const ingested = dryRun ? 0 : episodes.length;
      const finishedAt = new Date().toISOString();

      const details: Record<string, number> = {
        events_fetched: events.length,
        events_mapped: episodes.length,
        ...countEventsBySourceType(events),
      };

      return {
        connector: "bitbucket",
        source: "bitbucket",
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

    async mapEvent(event: BitbucketEvent): Promise<StatewaveEpisode> {
      return mapBitbucketEvent(event, { repo, subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<BitbucketKindGroup> {
  const base = new Set<BitbucketKindGroup>(
    include?.length ? (include as BitbucketKindGroup[]) : DEFAULT_INCLUDE,
  );
  if (exclude) for (const e of exclude) base.delete(e as BitbucketKindGroup);
  return base;
}

function countEventsBySourceType(events: ReadonlyArray<BitbucketEvent>): Record<string, number> {
  let issues = 0;
  let prs = 0;
  let issueComments = 0;
  let prComments = 0;
  for (const ev of events) {
    switch (ev.type) {
      case "issue":
        issues += 1;
        break;
      case "pull_request":
        prs += 1;
        break;
      case "comment":
        if (ev.parent === "issue") issueComments += 1;
        else prComments += 1;
        break;
    }
  }
  return {
    events_issues: issues,
    events_prs: prs,
    events_issue_comments: issueComments,
    events_pr_comments: prComments,
  };
}
