import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";
import type {
  GitlabApproval,
  GitlabEvent,
  GitlabEventKind,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNote,
  GitlabRelease,
  GitlabRepoRef,
} from "./types.js";

export interface MapperOptions {
  repo: GitlabRepoRef;
  subject?: string;
}

export function defaultSubject(repo: GitlabRepoRef): string {
  return `repo:${repo.owner}/${repo.name}`;
}

export function mapGitlabEvent(event: GitlabEvent, options: MapperOptions): StatewaveEpisode {
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
    case "merge_request":
      return mapMergeRequest(event, builder, repo);
    case "note":
      return mapNote(event, builder, repo);
    case "approval":
      return mapApproval(event, builder, repo);
    case "release":
      return mapRelease(event, builder, repo);
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      throw new ConnectorError("unsupported gitlab event type", {
        code: "mapping_failed",
        connector: "gitlab",
      });
    }
  }
}

function mapIssue(issue: GitlabIssue, builder: EpisodeBuilder, repo: GitlabRepoRef): StatewaveEpisode {
  const kind: GitlabEventKind = issue.state === "closed" ? "gitlab.issue.closed" : "gitlab.issue.opened";
  const occurred = issue.state === "closed" && issue.closed_at ? issue.closed_at : issue.created_at;
  const text = composeIssueText(issue);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "gitlab.issue",
      id: `${repo.owner}/${repo.name}#${issue.iid}`,
      url: issue.web_url,
    },
    metadata: {
      issue_iid: issue.iid,
      author: issue.author?.username,
      labels: [...issue.labels],
      milestone: issue.milestone?.title,
      state: issue.state,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    },
    idempotency_parts: ["gitlab", repo.owner, repo.name, "issue", issue.iid, kind],
  });
}

function mapMergeRequest(
  mr: GitlabMergeRequest,
  builder: EpisodeBuilder,
  repo: GitlabRepoRef,
): StatewaveEpisode {
  let kind: GitlabEventKind;
  let occurred: string;
  if (mr.state === "merged" && mr.merged_at) {
    kind = "gitlab.mr.merged";
    occurred = mr.merged_at;
  } else if (mr.state === "closed" && mr.closed_at) {
    kind = "gitlab.mr.closed";
    occurred = mr.closed_at;
  } else {
    kind = "gitlab.mr.opened";
    occurred = mr.created_at;
  }
  const text = composeMrText(mr);
  return builder.build({
    kind,
    text,
    occurred_at: occurred,
    source: {
      type: "gitlab.merge_request",
      id: `${repo.owner}/${repo.name}!${mr.iid}`,
      url: mr.web_url,
    },
    metadata: {
      mr_iid: mr.iid,
      author: mr.author?.username,
      labels: [...mr.labels],
      milestone: mr.milestone?.title,
      state: mr.state,
      merged: mr.state === "merged",
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
      created_at: mr.created_at,
      updated_at: mr.updated_at,
      related_subjects: [
        `mr:${mr.iid}`,
        mr.author ? `author:${mr.author.username}` : undefined,
      ].filter(Boolean),
    },
    idempotency_parts: ["gitlab", repo.owner, repo.name, "mr", mr.iid, kind],
  });
}

function mapNote(note: GitlabNote, builder: EpisodeBuilder, repo: GitlabRepoRef): StatewaveEpisode {
  const kind: GitlabEventKind =
    note.parent === "merge_request" ? "gitlab.mr.comment" : "gitlab.issue.comment";
  return builder.build({
    kind,
    text: note.body,
    occurred_at: note.created_at,
    source: {
      type: note.parent === "merge_request" ? "gitlab.mr.comment" : "gitlab.issue.comment",
      id: `${repo.owner}/${repo.name}#${note.parent_iid}/${note.id}`,
      url: `${note.parent_web_url}#note_${note.id}`,
    },
    metadata: {
      parent: note.parent,
      parent_iid: note.parent_iid,
      author: note.author?.username,
      created_at: note.created_at,
      updated_at: note.updated_at,
    },
    idempotency_parts: [
      "gitlab",
      repo.owner,
      repo.name,
      "note",
      note.parent,
      note.parent_iid,
      note.id,
    ],
  });
}

function mapApproval(
  approval: GitlabApproval,
  builder: EpisodeBuilder,
  repo: GitlabRepoRef,
): StatewaveEpisode {
  return builder.build({
    kind: "gitlab.mr.approval",
    text: composeApprovalText(approval),
    occurred_at: approval.occurred_at,
    source: {
      type: "gitlab.mr.approval",
      id: `${repo.owner}/${repo.name}!${approval.mr_iid}/approval/${approval.approver}`,
      url: approval.mr_web_url,
    },
    metadata: {
      mr_iid: approval.mr_iid,
      approver: approval.approver,
    },
    idempotency_parts: ["gitlab", repo.owner, repo.name, "approval", approval.mr_iid, approval.approver],
  });
}

function mapRelease(release: GitlabRelease, builder: EpisodeBuilder, repo: GitlabRepoRef): StatewaveEpisode {
  return builder.build({
    kind: "gitlab.release.published",
    text: composeReleaseText(release),
    occurred_at: release.released_at,
    source: {
      type: "gitlab.release",
      id: `${repo.owner}/${repo.name}@${release.tag_name}`,
      url: release.web_url,
    },
    metadata: {
      tag: release.tag_name,
      name: release.name ?? undefined,
      author: release.author?.username,
    },
    idempotency_parts: ["gitlab", repo.owner, repo.name, "release", release.tag_name],
  });
}

function composeIssueText(issue: GitlabIssue): string {
  const author = issue.author?.username ?? "unknown";
  const verb = issue.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} issue #${issue.iid}: ${issue.title}`;
  return issue.description ? `${header}\n\n${issue.description.trim()}` : header;
}

function composeMrText(mr: GitlabMergeRequest): string {
  const author = mr.author?.username ?? "unknown";
  const verb = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "opened";
  const header = `${author} ${verb} merge request !${mr.iid}: ${mr.title}`;
  return mr.description ? `${header}\n\n${mr.description.trim()}` : header;
}

function composeApprovalText(approval: GitlabApproval): string {
  return `${approval.approver} approved merge request !${approval.mr_iid}`;
}

function composeReleaseText(release: GitlabRelease): string {
  const author = release.author?.username ?? "unknown";
  const title = release.name ?? release.tag_name;
  const header = `${author} published release ${release.tag_name} — ${title}`;
  return release.description ? `${header}\n\n${release.description.trim()}` : header;
}
