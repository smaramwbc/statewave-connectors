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
import { JiraClient } from "./client.js";
import { mapJiraEvent } from "./mapper.js";
import type { JiraEvent } from "./types.js";

export interface JiraConnectorConfig {
  /** Jira Cloud site base URL, e.g. https://myorg.atlassian.net */
  baseUrl: string;
  /** Atlassian account email (basic-auth username). */
  email: string;
  /** Atlassian API token. */
  apiToken: string;
  /** Allowlisted project keys — required; ingesting a whole site is refused. */
  projects: ReadonlyArray<string>;
  /** Override the per-issue default subject (`project:<KEY>`). */
  subject?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_INCLUDE = ["issues"] as const;
const KNOWN_GROUPS = new Set(["issues", "comments"]);
/** Bound a no-`--max-items` pull so a large site can't be ingested by accident. */
const DEFAULT_MAX_ITEMS = 1000;

export function createJiraConnector(
  config: JiraConnectorConfig,
): StatewaveConnector<JiraConnectorConfig, JiraEvent> {
  if (!config.projects || config.projects.length === 0) {
    throw new ConnectorError("at least one Jira project key is required", {
      code: "config_invalid",
      connector: "jira",
      hint: "pass projects: ['ENG'] — ingesting an entire Jira site by default would be surprising",
    });
  }
  const client = new JiraClient({
    baseUrl: config.baseUrl,
    email: config.email,
    apiToken: config.apiToken,
    fetchImpl: config.fetchImpl,
  });
  const host = safeHost(config.baseUrl);

  return {
    id: `jira:${host}`,
    name: "Jira",
    source: "jira",

    async configure(_next: JiraConnectorConfig): Promise<void> {
      throw new ConnectorError("jira connector is configured at construction time", {
        code: "unsupported",
        connector: "jira",
      });
    },

    async check(): Promise<ConnectorCheckResult> {
      return {
        connector: "jira",
        status: "ok",
        details: [
          { name: "site", status: "ok", message: host },
          {
            name: "auth",
            status: config.email && config.apiToken ? "ok" : "error",
            message: config.email && config.apiToken ? "api-token configured" : "missing email/token",
          },
          { name: "projects", status: "ok", message: config.projects.join(", ") },
        ],
      };
    },

    async sync(options: SyncOptions): Promise<SyncResult> {
      const startedAt = new Date().toISOString();
      const groups = resolveGroups(options.include, options.exclude);
      const since = options.since ? new Date(options.since).toISOString() : undefined;
      const max = options.maxItems ?? DEFAULT_MAX_ITEMS;
      const subject = options.subject ?? config.subject;

      const issues = await client.searchIssues({ projects: config.projects, since, max });
      const events: JiraEvent[] = [];
      let commentsFetched = 0;
      for (const issue of issues) {
        if (groups.has("issues")) events.push(issue);
        if (groups.has("comments")) {
          const comments = await client.listComments(issue.key, issue.projectKey);
          commentsFetched += comments.length;
          for (const c of comments) events.push(c);
        }
        if (events.length >= max) break;
      }

      const limited = events.slice(0, max);
      const episodes: StatewaveEpisode[] = limited.map((ev) => {
        const ep = mapJiraEvent(ev, { subject });
        return options.redaction ? redactEpisodeText(ep, options.redaction) : ep;
      });

      const dryRun = !!options.dryRun;
      const finishedAt = new Date().toISOString();
      const details: Record<string, number> = {
        issues_fetched: issues.length,
        comments_fetched: commentsFetched,
        events_mapped: episodes.length,
      };

      return {
        connector: "jira",
        source: "jira",
        subject,
        episodes,
        ingested: dryRun ? 0 : episodes.length,
        skipped: events.length - episodes.length,
        dryRun,
        startedAt,
        finishedAt,
        summary: summarizeEpisodes(episodes, details),
      };
    },

    async mapEvent(event: JiraEvent): Promise<StatewaveEpisode> {
      return mapJiraEvent(event, { subject: config.subject });
    },
  };
}

function resolveGroups(
  include: ReadonlyArray<string> | undefined,
  exclude: ReadonlyArray<string> | undefined,
): Set<string> {
  const base = new Set<string>(
    include?.length ? include.filter((g) => KNOWN_GROUPS.has(g)) : DEFAULT_INCLUDE,
  );
  if (base.size === 0) base.add("issues");
  if (exclude) for (const e of exclude) base.delete(e);
  return base;
}

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
