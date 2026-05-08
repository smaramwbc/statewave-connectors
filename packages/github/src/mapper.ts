import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  GithubComment,
  GithubEvent,
  GithubEventKind,
  GithubIssue,
  GithubPullRequest,
  GithubRelease,
  GithubRepoRef,
  GithubReview,
} from "./types.js";

export interface MapperOptions {
  repo: GithubRepoRef;
  subject?: string;
}

export function defaultSubject(repo: GithubRepoRef): string {
  return `repo:${repo.owner}/${repo.name}`;
}

export function mapGithubEvent(event: GithubEvent, options: MapperOptions): StatewaveEpisode {
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
    case "review":
      return mapReview(event, builder, repo);
    case "release":
      return mapRelease(event, builder, repo);
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported github event type", {
        code: "mapping_failed",
        connector: "github",
      });
    }
  }
}

function mapIssue(issue: GithubIssue, builder: EpisodeBuilder, repo: GithubRepoRef): StatewaveEpisode {
  const kind: GithubEventKind = issue.state === "closed" ? "github.issue.closed" : "github.issue.opened";
  const occurred = issue.state === "closed" && issue.closed_at ? issue.closed_at : issue.created_at;
  const text = composeIssueText(issue);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "github.issue",
      id: `${repo.owner}/${repo.name}#${issue.number}`,
      url: issue.html_url,
    },
    metadata: {
      issue_number: issue.number,
      author: issue.user?.login,
      labels: issue.labels.map((l) => l.name),
      milestone: issue.milestone?.title,
      state: issue.state,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    idempotency_parts: ["github", repo.owner, repo.name, "issue", issue.number, kind],
  });
}

function mapPullRequest(
  pr: GithubPullRequest,
  builder: EpisodeBuilder,
  repo: GithubRepoRef,
): StatewaveEpisode {
  let kind: GithubEventKind;
  let occurred: string;
  if (pr.merged && pr.merged_at) {
    kind = "github.pr.merged";
    occurred = pr.merged_at;
  } else if (pr.state === "closed" && pr.closed_at) {
    kind = "github.pr.closed";
    occurred = pr.closed_at;
  } else {
    kind = "github.pr.opened";
    occurred = pr.created_at;
  }
  const text = composePrText(pr);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "github.pull_request",
      id: `${repo.owner}/${repo.name}#${pr.number}`,
      url: pr.html_url,
    },
    metadata: {
      pr_number: pr.number,
      author: pr.user?.login,
      labels: pr.labels.map((l) => l.name),
      milestone: pr.milestone?.title,
      state: pr.state,
      merged: pr.merged,
      base: pr.base?.ref,
      head: pr.head?.ref,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      related_subjects: [`pr:${pr.number}`, pr.user ? `author:${pr.user.login}` : undefined].filter(
        Boolean,
      ),
    },
    idempotency_parts: ["github", repo.owner, repo.name, "pr", pr.number, kind],
  });
}

function mapComment(comment: GithubComment, builder: EpisodeBuilder, repo: GithubRepoRef): StatewaveEpisode {
  const kind: GithubEventKind = comment.parent === "pull_request" ? "github.pr.comment" : "github.issue.comment";
  return builder.build({
    kind,
    text: comment.body,
    occurred_at: comment.created_at,
    source: {
      type: comment.parent === "pull_request" ? "github.pr.comment" : "github.issue.comment",
      id: `${repo.owner}/${repo.name}#${comment.parent_number}/${comment.id}`,
      url: comment.html_url,
    },
    metadata: {
      parent: comment.parent,
      parent_number: comment.parent_number,
      author: comment.user?.login,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
    },
    idempotency_parts: [
      "github",
      repo.owner,
      repo.name,
      "comment",
      comment.parent,
      comment.parent_number,
      comment.id,
    ],
  });
}

function mapReview(review: GithubReview, builder: EpisodeBuilder, repo: GithubRepoRef): StatewaveEpisode {
  return builder.build({
    kind: "github.pr.review",
    text: composeReviewText(review),
    occurred_at: review.submitted_at,
    source: {
      type: "github.pr.review",
      id: `${repo.owner}/${repo.name}#${review.pr_number}/review/${review.id}`,
      url: review.html_url,
    },
    metadata: {
      pr_number: review.pr_number,
      author: review.user?.login,
      state: review.state,
    },
    idempotency_parts: ["github", repo.owner, repo.name, "review", review.pr_number, review.id],
  });
}

function mapRelease(release: GithubRelease, builder: EpisodeBuilder, repo: GithubRepoRef): StatewaveEpisode {
  return builder.build({
    kind: "github.release.published",
    text: composeReleaseText(release),
    occurred_at: release.published_at,
    source: {
      type: "github.release",
      id: `${repo.owner}/${repo.name}@${release.tag_name}`,
      url: release.html_url,
    },
    metadata: {
      tag: release.tag_name,
      name: release.name ?? undefined,
      author: release.author?.login,
    },
    idempotency_parts: ["github", repo.owner, repo.name, "release", release.id],
  });
}

function composeIssueText(issue: GithubIssue): string {
  const author = issue.user?.login ?? "unknown";
  const verb = issue.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} issue #${issue.number}: ${issue.title}`;
  return issue.body ? `${header}\n\n${issue.body.trim()}` : header;
}

function composePrText(pr: GithubPullRequest): string {
  const author = pr.user?.login ?? "unknown";
  const verb = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} PR #${pr.number}: ${pr.title}`;
  return pr.body ? `${header}\n\n${pr.body.trim()}` : header;
}

function composeReviewText(review: GithubReview): string {
  const author = review.user?.login ?? "unknown";
  const header = `${author} reviewed PR #${review.pr_number} (${review.state})`;
  return review.body ? `${header}\n\n${review.body.trim()}` : header;
}

function composeReleaseText(release: GithubRelease): string {
  const author = release.author?.login ?? "unknown";
  const title = release.name ?? release.tag_name;
  const header = `${author} published release ${release.tag_name} — ${title}`;
  return release.body ? `${header}\n\n${release.body.trim()}` : header;
}
