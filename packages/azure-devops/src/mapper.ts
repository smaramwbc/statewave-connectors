import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  AzureComment,
  AzureEvent,
  AzureEventKind,
  AzurePullRequest,
  AzureRepoRef,
  AzureReview,
  AzureWorkItem,
} from "./types.js";

export interface MapperOptions {
  repo: AzureRepoRef;
  subject?: string;
}

export function defaultSubject(repo: AzureRepoRef): string {
  return `repo:${repo.organization}/${repo.project}/${repo.repository}`;
}

export function mapAzureEvent(event: AzureEvent, options: MapperOptions): StatewaveEpisode {
  const repo = options.repo;
  const subject = options.subject ?? defaultSubject(repo);
  const builder = new EpisodeBuilder({
    subject,
    metadata: {
      organization: repo.organization,
      project: repo.project,
      repository: repo.repository,
    },
  });

  switch (event.type) {
    case "pull_request":
      return mapPullRequest(event, builder, repo);
    case "comment":
      return mapComment(event, builder, repo);
    case "review":
      return mapReview(event, builder, repo);
    case "work_item":
      return mapWorkItem(event, builder, repo);
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported azure devops event type", {
        code: "mapping_failed",
        connector: "azure-devops",
      });
    }
  }
}

function repoKey(repo: AzureRepoRef): string {
  return `${repo.organization}/${repo.project}/${repo.repository}`;
}

function mapPullRequest(
  pr: AzurePullRequest,
  builder: EpisodeBuilder,
  repo: AzureRepoRef,
): StatewaveEpisode {
  let kind: AzureEventKind;
  let occurred: string;
  if (pr.merged) {
    kind = "azure.pr.merged";
    occurred = pr.closedDate ?? pr.creationDate;
  } else if (pr.status === "abandoned") {
    kind = "azure.pr.closed";
    occurred = pr.closedDate ?? pr.creationDate;
  } else {
    kind = "azure.pr.opened";
    occurred = pr.creationDate;
  }
  const author = pr.createdBy?.displayName ?? "unknown";
  return builder.build({
    kind,
    text: composePrText(pr),
    occurred_at: occurred,
    source: {
      type: "azure.pull_request",
      id: `${repoKey(repo)}#${pr.pullRequestId}`,
      url: pr.html_url,
    },
    metadata: {
      pr_id: pr.pullRequestId,
      author,
      status: pr.status,
      merged: pr.merged,
      source_ref: pr.sourceRefName,
      target_ref: pr.targetRefName,
      created_at: pr.creationDate,
      closed_at: pr.closedDate ?? undefined,
      related_subjects: [
        `pr:${pr.pullRequestId}`,
        pr.createdBy?.displayName ? `author:${pr.createdBy.displayName}` : undefined,
      ].filter(Boolean),
    },
    idempotency_parts: [
      "azure",
      repo.organization,
      repo.project,
      repo.repository,
      "pr",
      pr.pullRequestId,
      kind,
    ],
  });
}

function mapComment(
  comment: AzureComment,
  builder: EpisodeBuilder,
  repo: AzureRepoRef,
): StatewaveEpisode {
  return builder.build({
    kind: "azure.pr.comment",
    text: comment.content,
    occurred_at: comment.publishedDate,
    source: {
      type: "azure.pr.comment",
      id: `${repoKey(repo)}#${comment.pr_id}/${comment.thread_id}/${comment.id}`,
      url: comment.html_url,
    },
    metadata: {
      pr_id: comment.pr_id,
      thread_id: comment.thread_id,
      author: comment.author?.displayName,
      published_at: comment.publishedDate,
    },
    idempotency_parts: [
      "azure",
      repo.organization,
      repo.project,
      repo.repository,
      "comment",
      comment.pr_id,
      comment.thread_id,
      comment.id,
    ],
  });
}

function mapReview(
  review: AzureReview,
  builder: EpisodeBuilder,
  repo: AzureRepoRef,
): StatewaveEpisode {
  return builder.build({
    kind: "azure.pr.review",
    text: composeReviewText(review),
    occurred_at: review.occurred_at,
    source: {
      type: "azure.pr.review",
      id: `${repoKey(repo)}#${review.pr_id}/review/${review.reviewer_index}`,
      url: review.html_url,
    },
    metadata: {
      pr_id: review.pr_id,
      author: review.reviewer?.displayName,
      vote: review.vote,
      state: review.state,
    },
    idempotency_parts: [
      "azure",
      repo.organization,
      repo.project,
      repo.repository,
      "review",
      review.pr_id,
      review.reviewer_index,
    ],
  });
}

function mapWorkItem(
  item: AzureWorkItem,
  builder: EpisodeBuilder,
  repo: AzureRepoRef,
): StatewaveEpisode {
  const kind: AzureEventKind = item.closed ? "azure.workitem.closed" : "azure.workitem.created";
  return builder.build({
    kind,
    text: composeWorkItemText(item),
    occurred_at: item.createdDate,
    source: {
      type: "azure.work_item",
      id: `${repoKey(repo)}/workitem/${item.id}`,
      url: item.html_url,
    },
    metadata: {
      work_item_id: item.id,
      title: item.title,
      work_item_type: item.workItemType,
      state: item.state,
      author: item.createdBy?.displayName,
      created_at: item.createdDate,
      changed_at: item.changedDate,
    },
    idempotency_parts: [
      "azure",
      repo.organization,
      repo.project,
      repo.repository,
      "workitem",
      item.id,
      kind,
    ],
  });
}

function composePrText(pr: AzurePullRequest): string {
  const author = pr.createdBy?.displayName ?? "unknown";
  const verb = pr.merged ? "merged" : pr.status === "abandoned" ? "abandoned" : "opened";
  const header = `${author} ${verb} PR !${pr.pullRequestId}: ${pr.title}`;
  return pr.description ? `${header}\n\n${pr.description.trim()}` : header;
}

function composeReviewText(review: AzureReview): string {
  const author = review.reviewer?.displayName ?? "unknown";
  return `${author} reviewed PR !${review.pr_id} (${review.state})`;
}

function composeWorkItemText(item: AzureWorkItem): string {
  const author = item.createdBy?.displayName ?? "unknown";
  const verb = item.closed ? "closed" : "created";
  return `${author} ${verb} ${item.workItemType} #${item.id}: ${item.title}`;
}
