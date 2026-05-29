import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  BitbucketComment,
  BitbucketEvent,
  BitbucketEventKind,
  BitbucketIssue,
  BitbucketPullRequest,
  BitbucketRepoRef,
  BitbucketUser,
} from "./types.js";

export interface MapperOptions {
  repo: BitbucketRepoRef;
  subject?: string;
}

export function defaultSubject(repo: BitbucketRepoRef): string {
  return `repo:${repo.owner}/${repo.name}`;
}

function authorName(user: BitbucketUser | null | undefined): string {
  return user?.nickname ?? user?.display_name ?? "unknown";
}

export function mapBitbucketEvent(event: BitbucketEvent, options: MapperOptions): StatewaveEpisode {
  const repo = options.repo;
  const subject = options.subject ?? defaultSubject(repo);
  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      repo_owner: repo.owner,
      repo_name: repo.name,
    },
  });

  switch (event.type) {
    case "issue":
      return mapIssue(event, builder, repo);
    case "pull_request":
      return mapPullRequest(event, builder, repo);
    case "comment":
      return mapComment(event, builder, repo);
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported bitbucket event type", {
        code: "mapping_failed",
        connector: "bitbucket",
      });
    }
  }
}

function mapIssue(
  issue: BitbucketIssue,
  builder: EpisodeBuilder,
  repo: BitbucketRepoRef,
): StatewaveEpisode {
  const kind: BitbucketEventKind =
    issue.state === "closed" ? "bitbucket.issue.closed" : "bitbucket.issue.opened";
  const occurred = issue.state === "closed" ? issue.updated_at : issue.created_at;
  return builder.build({
    kind,
    text: composeIssueText(issue),
    occurred_at: occurred,
    source: {
      type: "bitbucket.issue",
      id: `${repo.owner}/${repo.name}#${issue.id}`,
      url: issue.html_url,
    },
    metadata: {
      issue_id: issue.id,
      author: authorName(issue.user),
      state: issue.state,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    idempotency_parts: ["bitbucket", repo.owner, repo.name, "issue", issue.id, kind],
  });
}

function mapPullRequest(
  pr: BitbucketPullRequest,
  builder: EpisodeBuilder,
  repo: BitbucketRepoRef,
): StatewaveEpisode {
  let kind: BitbucketEventKind;
  let occurred: string;
  if (pr.merged) {
    kind = "bitbucket.pr.merged";
    occurred = pr.updated_at;
  } else if (pr.declined) {
    kind = "bitbucket.pr.closed";
    occurred = pr.updated_at;
  } else {
    kind = "bitbucket.pr.opened";
    occurred = pr.created_at;
  }
  return builder.build({
    kind,
    text: composePrText(pr),
    occurred_at: occurred,
    source: {
      type: "bitbucket.pull_request",
      id: `${repo.owner}/${repo.name}#${pr.id}`,
      url: pr.html_url,
    },
    metadata: {
      pr_id: pr.id,
      author: authorName(pr.user),
      state: pr.state,
      merged: pr.merged,
      source_branch: pr.source_branch,
      destination_branch: pr.destination_branch,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      related_subjects: [
        `pr:${pr.id}`,
        pr.user ? `author:${authorName(pr.user)}` : undefined,
      ].filter(Boolean),
    },
    idempotency_parts: ["bitbucket", repo.owner, repo.name, "pr", pr.id, kind],
  });
}

function mapComment(
  comment: BitbucketComment,
  builder: EpisodeBuilder,
  repo: BitbucketRepoRef,
): StatewaveEpisode {
  const isIssue = comment.parent === "issue";
  const kind: BitbucketEventKind = isIssue
    ? "bitbucket.issue.comment"
    : "bitbucket.pr.comment";
  const sourceType = isIssue ? "bitbucket.issue.comment" : "bitbucket.pr.comment";
  return builder.build({
    kind,
    text: comment.body,
    occurred_at: comment.created_at,
    source: {
      type: sourceType,
      id: `${repo.owner}/${repo.name}#${comment.parent_id}/${comment.id}`,
      url: comment.html_url,
    },
    metadata: {
      parent: comment.parent,
      parent_id: comment.parent_id,
      parent_number: comment.parent_id,
      author: authorName(comment.user),
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    },
    idempotency_parts: [
      "bitbucket",
      repo.owner,
      repo.name,
      "comment",
      comment.parent,
      comment.parent_id,
      comment.id,
    ],
  });
}

function composeIssueText(issue: BitbucketIssue): string {
  const author = authorName(issue.user);
  const verb = issue.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} issue #${issue.id}: ${issue.title}`;
  return issue.body ? `${header}\n\n${issue.body.trim()}` : header;
}

function composePrText(pr: BitbucketPullRequest): string {
  const author = authorName(pr.user);
  const verb = pr.merged ? "merged" : pr.declined ? "closed" : "opened";
  const header = `${author} ${verb} PR #${pr.id}: ${pr.title}`;
  return pr.body ? `${header}\n\n${pr.body.trim()}` : header;
}
