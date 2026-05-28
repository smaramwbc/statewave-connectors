import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type { JiraComment, JiraEvent, JiraEventKind, JiraIssue } from "./types.js";

export interface MapperOptions {
  /** Override the per-event default subject (`project:<KEY>`). */
  subject?: string;
}

export function defaultSubject(projectKey: string): string {
  return `project:${projectKey}`;
}

export function mapJiraEvent(event: JiraEvent, options: MapperOptions = {}): StatewaveEpisode {
  switch (event.type) {
    case "issue":
      return mapIssue(event, options);
    case "comment":
      return mapComment(event, options);
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported jira event type", {
        code: "mapping_failed",
        connector: "jira",
      });
    }
  }
}

function issueKind(issue: JiraIssue): JiraEventKind {
  return issue.statusCategory === "done" ? "jira.issue.resolved" : "jira.issue.created";
}

function mapIssue(issue: JiraIssue, options: MapperOptions): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(issue.projectKey);
  const kind = issueKind(issue);
  const occurred =
    kind === "jira.issue.resolved" ? (issue.resolutionDate ?? issue.updated) : issue.created;
  const builder = new EpisodeBuilder({ subject });
  return builder.build({
    kind,
    text: composeIssueText(issue, kind),
    occurred_at: occurred,
    source: {
      type: "jira.issue",
      id: issue.key,
      url: issue.url,
    },
    metadata: {
      issue_key: issue.key,
      project_key: issue.projectKey,
      status: issue.statusName,
      status_category: issue.statusCategory,
      issue_type: issue.issueType,
      priority: issue.priority,
      labels: issue.labels,
      assignee: issue.assignee ?? undefined,
      reporter: issue.reporter ?? undefined,
      created: issue.created,
      updated: issue.updated,
      resolution_date: issue.resolutionDate ?? undefined,
      related_subjects: [
        `issue:${issue.key}`,
        issue.assignee ? `assignee:${issue.assignee}` : undefined,
      ].filter(Boolean),
    },
    idempotency_parts: ["jira", issue.projectKey, "issue", issue.key, kind],
  });
}

function mapComment(comment: JiraComment, options: MapperOptions): StatewaveEpisode {
  const subject = options.subject ?? defaultSubject(comment.projectKey);
  const builder = new EpisodeBuilder({ subject });
  return builder.build({
    kind: "jira.comment.created",
    text: composeCommentText(comment),
    occurred_at: comment.created,
    source: {
      type: "jira.comment",
      id: `${comment.issueKey}/${comment.id}`,
      url: comment.url,
    },
    metadata: {
      issue_key: comment.issueKey,
      project_key: comment.projectKey,
      author: comment.author ?? undefined,
      created: comment.created,
      updated: comment.updated,
      related_subjects: [
        `issue:${comment.issueKey}`,
        comment.author ? `author:${comment.author}` : undefined,
      ].filter(Boolean),
    },
    idempotency_parts: ["jira", comment.projectKey, "comment", comment.issueKey, comment.id],
  });
}

function composeIssueText(issue: JiraIssue, kind: JiraEventKind): string {
  const verb = kind === "jira.issue.resolved" ? "resolved" : "created";
  const who =
    (verb === "resolved" ? issue.assignee : issue.reporter) ?? issue.reporter ?? "unknown";
  const header = `${who} ${verb} issue ${issue.key}: ${issue.summary}`;
  const desc = issue.description.trim();
  return desc ? `${header}\n\n${desc}` : header;
}

function composeCommentText(comment: JiraComment): string {
  const header = `${comment.author ?? "unknown"} commented on ${comment.issueKey}`;
  const body = comment.body.trim();
  return body ? `${header}\n\n${body}` : header;
}
