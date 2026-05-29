import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  GiteaComment,
  GiteaEvent,
  GiteaEventKind,
  GiteaIssue,
  GiteaPullRequest,
  GiteaRelease,
  GiteaRepoRef,
  GiteaReview,
} from "./types.js";

export interface MapperOptions {
  repo: GiteaRepoRef;
  subject?: string;
}

export function defaultSubject(repo: GiteaRepoRef): string {
  return `repo:${repo.owner}/${repo.name}`;
}

export function mapGiteaEvent(event: GiteaEvent, options: MapperOptions): StatewaveEpisode {
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
      throw new ConnectorError("unsupported gitea event type", {
        code: "mapping_failed",
        connector: "gitea",
      });
    }
  }
}

function mapIssue(issue: GiteaIssue, builder: EpisodeBuilder, repo: GiteaRepoRef): StatewaveEpisode {
  const kind: GiteaEventKind = issue.state === "closed" ? "gitea.issue.closed" : "gitea.issue.opened";
  const occurred = issue.state === "closed" && issue.closed_at ? issue.closed_at : issue.created_at;
  const text = composeIssueText(issue);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "gitea.issue",
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
    idempotency_parts: ["gitea", repo.owner, repo.name, "issue", issue.number, kind],
  });
}

function mapPullRequest(
  pr: GiteaPullRequest,
  builder: EpisodeBuilder,
  repo: GiteaRepoRef,
): StatewaveEpisode {
  let kind: GiteaEventKind;
  let occurred: string;
  if (pr.merged && pr.merged_at) {
    kind = "gitea.pr.merged";
    occurred = pr.merged_at;
  } else if (pr.state === "closed" && pr.closed_at) {
    kind = "gitea.pr.closed";
    occurred = pr.closed_at;
  } else {
    kind = "gitea.pr.opened";
    occurred = pr.created_at;
  }
  const text = composePrText(pr);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "gitea.pull_request",
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
    idempotency_parts: ["gitea", repo.owner, repo.name, "pr", pr.number, kind],
  });
}

function mapComment(comment: GiteaComment, builder: EpisodeBuilder, repo: GiteaRepoRef): StatewaveEpisode {
  const kind: GiteaEventKind = comment.parent === "pull_request" ? "gitea.pr.comment" : "gitea.issue.comment";
  return builder.build({
    kind,
    text: comment.body,
    occurred_at: comment.created_at,
    source: {
      type: comment.parent === "pull_request" ? "gitea.pr.comment" : "gitea.issue.comment",
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
      "gitea",
      repo.owner,
      repo.name,
      "comment",
      comment.parent,
      comment.parent_number,
      comment.id,
    ],
  });
}

function mapReview(review: GiteaReview, builder: EpisodeBuilder, repo: GiteaRepoRef): StatewaveEpisode {
  return builder.build({
    kind: "gitea.pr.review",
    text: composeReviewText(review),
    occurred_at: review.submitted_at,
    source: {
      type: "gitea.pr.review",
      id: `${repo.owner}/${repo.name}#${review.pr_number}/review/${review.id}`,
      url: review.html_url,
    },
    metadata: {
      pr_number: review.pr_number,
      author: review.user?.login,
      state: review.state,
    },
    idempotency_parts: ["gitea", repo.owner, repo.name, "review", review.pr_number, review.id],
  });
}

function mapRelease(release: GiteaRelease, builder: EpisodeBuilder, repo: GiteaRepoRef): StatewaveEpisode {
  return builder.build({
    kind: "gitea.release.published",
    text: composeReleaseText(release),
    occurred_at: release.published_at,
    source: {
      type: "gitea.release",
      id: `${repo.owner}/${repo.name}@${release.tag_name}`,
      url: release.html_url,
    },
    metadata: {
      tag: release.tag_name,
      name: release.name ?? undefined,
      author: release.author?.login,
    },
    idempotency_parts: ["gitea", repo.owner, repo.name, "release", release.id],
  });
}

function composeIssueText(issue: GiteaIssue): string {
  const author = issue.user?.login ?? "unknown";
  const verb = issue.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} issue #${issue.number}: ${issue.title}`;
  return issue.body ? `${header}\n\n${issue.body.trim()}` : header;
}

function composePrText(pr: GiteaPullRequest): string {
  const author = pr.user?.login ?? "unknown";
  const verb = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} PR #${pr.number}: ${pr.title}`;
  return pr.body ? `${header}\n\n${pr.body.trim()}` : header;
}

function composeReviewText(review: GiteaReview): string {
  const author = review.user?.login ?? "unknown";
  const header = `${author} reviewed PR #${review.pr_number} (${review.state})`;
  return review.body ? `${header}\n\n${review.body.trim()}` : header;
}

function composeReleaseText(release: GiteaRelease): string {
  const author = release.author?.login ?? "unknown";
  const title = release.name ?? release.tag_name;
  const header = `${author} published release ${release.tag_name} — ${title}`;
  return release.body ? `${header}\n\n${release.body.trim()}` : header;
}
