import { createHash } from "node:crypto";
import {
  EpisodeBuilder,
  type StatewaveEpisode,
} from "@statewavedev/connectors-core";
import type {
  ChangedFile,
  DiagnosticRecord,
  GitContext,
  ProjectSummary,
  ScannedWorkspaceFile,
  WorkspaceScan,
} from "./types.js";
import type { ProjectCommand } from "./commands.js";
import { applyRedaction, redactText } from "./redaction.js";
import { renderProjectSummaryText, fileTitle } from "./summary.js";

/**
 * Episode mapping helpers — the bridge from editor-observed state to the
 * normalized `StatewaveEpisode` shape every connector produces.
 *
 * Rules followed throughout:
 *   - Build via `EpisodeBuilder` (connectors-core) for one consistent shape.
 *   - Idempotency is content-addressable: identical observed state re-maps to
 *     the same `idempotency_key` (Statewave dedupes); changed state yields a
 *     new key (a new memory). No volatile timestamp ever sits in the key for
 *     state-snapshot episodes.
 *   - Redaction (when enabled) is applied to `text` as the last step, reusing
 *     connectors-core redaction.
 *   - No file *contents* are embedded unless a caller explicitly passes them
 *     (architecture docs only). Diagnostics never carry source.
 */

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const SOURCE_IDE = "ide";

export interface BaseMapInput {
  subject: string;
  redactionEnabled: boolean;
  /** Override occurred_at (tests). Defaults to now inside EpisodeBuilder. */
  occurredAt?: string;
}

/** `ide.workspace.indexed` — one episode summarising a full scan. */
export function workspaceIndexedEpisode(
  input: BaseMapInput & { scan: WorkspaceScan },
): StatewaveEpisode {
  const { scan } = input;
  const byCategory: Record<string, number> = {};
  const fingerprint: string[] = [];
  for (const f of scan.files) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    fingerprint.push(`${f.relativePath}:${f.hash}`);
  }
  const stateHash = shortHash(fingerprint.join("\n"));
  const text =
    `Indexed ${scan.files.length} files in workspace "${scan.folderName}" ` +
    `(${scan.filesVisited} visited, ${scan.filesIgnored} ignored).`;

  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.workspace.indexed",
    text,
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.workspace`, id: scan.folderName },
    metadata: {
      file_count: scan.files.length,
      files_visited: scan.filesVisited,
      files_ignored: scan.filesIgnored,
      by_category: byCategory,
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "workspace.indexed", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

/** `ide.project.summary` — the durable, compiled-friendly project model. */
export function projectSummaryEpisode(
  input: BaseMapInput & { summary: ProjectSummary },
): StatewaveEpisode {
  const text = renderProjectSummaryText(input.summary);
  const stateHash = shortHash(text);
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.project.summary",
    text,
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.project`, id: input.summary.name },
    metadata: {
      languages: input.summary.languages,
      toolchain: input.summary.toolchain,
      layout: input.summary.layout,
      conventions: input.summary.conventions,
      has_tests: input.summary.hasTests,
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "project.summary", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

/**
 * `ide.project.commands` — the declared run-commands a developer would type
 * (test / build / lint / start …), so the assistant can answer "how do I run
 * this?" from memory. Only **declared** command surfaces are collected:
 * `package.json` scripts, `Makefile` targets, and `pyproject.toml`
 * `[project.scripts]` / `[tool.poetry.scripts]`. No source bodies, lockfiles,
 * env files, or chat. Command strings are redacted (when enabled) since a
 * script line can embed a literal token.
 */
export function projectCommandsEpisode(
  input: BaseMapInput & { commands: ReadonlyArray<ProjectCommand> },
): StatewaveEpisode {
  const sorted = [...input.commands].sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
  const redacted = sorted.map((c) => ({
    ...c,
    command: redactText(c.command, input.redactionEnabled),
  }));
  const bySource: Record<string, number> = {};
  for (const c of sorted) bySource[c.source] = (bySource[c.source] ?? 0) + 1;

  const lines = [`Project run-commands (${redacted.length}):`];
  for (const c of redacted) {
    lines.push(`- ${c.name} [${c.source}]: ${c.command}`);
  }
  // Idempotency keys on the declared surface (name+command+source), not on
  // volatile mtime — re-running with unchanged manifests dedupes.
  const stateHash = shortHash(
    sorted.map((c) => `${c.source}|${c.name}|${c.command}`).join("\n"),
  );
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.project.commands",
    text: lines.join("\n"),
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.project`, id: "commands" },
    metadata: {
      command_count: redacted.length,
      by_source: bySource,
      commands: redacted.map((c) => ({
        name: c.name,
        source: c.source,
        command: c.command,
      })),
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "project.commands", input.subject, stateHash],
  });
  // text built from already-redacted commands; this is a no-op safety net.
  return applyRedaction(ep, input.redactionEnabled);
}

/** `ide.git.context` — branch + remote, so agents know what's being worked on. */
export function gitContextEpisode(
  input: BaseMapInput & { git: GitContext },
): StatewaveEpisode {
  const { git } = input;
  const parts = [
    git.branch ? `branch ${git.branch}` : "detached / no branch",
    git.remoteUrl ? `remote ${git.remoteUrl}` : "no remote",
  ];
  const text = `Git context: ${parts.join(", ")}.`;
  const stateHash = shortHash(`${git.branch}|${git.remoteUrl}`);
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.git.context",
    text,
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.git`, id: git.remoteUrl ?? input.subject },
    metadata: {
      branch: git.branch,
      remote_url: git.remoteUrl,
      host: git.host,
      owner: git.owner,
      repo: git.repo,
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "git.context", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

/** `ide.docs.detected` — a single digest of every documentation surface found. */
export function docsDetectedEpisode(
  input: BaseMapInput & { docs: ReadonlyArray<ScannedWorkspaceFile> },
): StatewaveEpisode {
  const sorted = [...input.docs].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  const list = sorted.map((d) => `- ${d.relativePath} (${d.category})`);
  const text = [`Detected ${sorted.length} documentation file(s):`, ...list].join(
    "\n",
  );
  const stateHash = shortHash(
    sorted.map((d) => `${d.relativePath}:${d.hash}`).join("\n"),
  );
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.docs.detected",
    text,
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.docs`, id: input.subject },
    metadata: {
      doc_count: sorted.length,
      docs: sorted.map((d) => ({ path: d.relativePath, category: d.category })),
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "docs.detected", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

export interface ArchitectureDocInput {
  relativePath: string;
  hash: string;
  /** Optional file content — only passed for ADR/RFC/decision docs. */
  content?: string;
}

/** `ide.architecture.detected` — one episode per ADR / RFC / decision doc. */
export function architectureDetectedEpisode(
  input: BaseMapInput & { doc: ArchitectureDocInput },
): StatewaveEpisode {
  const { doc } = input;
  const title = deriveDocTitle(doc.content, doc.relativePath);
  const body = doc.content ? clip(doc.content.trim(), 4000) : "";
  const text = body ? `# ${title}\n\n${body}` : `Architecture doc: ${title}`;
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.architecture.detected",
    text,
    occurred_at: input.occurredAt,
    source: {
      type: `${SOURCE_IDE}.architecture`,
      id: doc.relativePath,
      url: `file://${doc.relativePath}`,
    },
    metadata: {
      path: doc.relativePath,
      title,
      hash: doc.hash,
    },
    // Content-addressable: same path + same content hash → same memory.
    idempotency_parts: [
      SOURCE_IDE,
      "architecture.detected",
      input.subject,
      doc.relativePath,
      doc.hash,
    ],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

/** `ide.file.changed` — one episode per debounced save/create/delete. */
export function fileChangedEpisode(
  input: BaseMapInput & { change: ChangedFile },
): StatewaveEpisode {
  const { change } = input;
  const verb =
    change.changeType === "deleted"
      ? "deleted"
      : change.changeType === "created"
        ? "created"
        : "saved";
  const cat = change.category ? ` (${change.category})` : "";
  const text = `${verb} ${change.relativePath}${cat}`;
  // Saves/creates are content-addressable on the hash; deletes have no hash so
  // they key on the path + intent (re-deleting the same path dedupes).
  const idemTail =
    change.changeType === "deleted"
      ? ["deleted"]
      : [change.hash ?? "nohash"];
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.file.changed",
    text,
    occurred_at: input.occurredAt ?? change.occurredAt,
    source: {
      type: `${SOURCE_IDE}.file`,
      id: change.relativePath,
      url: `file://${change.absolutePath}`,
    },
    metadata: {
      path: change.relativePath,
      change_type: change.changeType,
      category: change.category,
      hash: change.hash,
    },
    idempotency_parts: [
      SOURCE_IDE,
      "file.changed",
      input.subject,
      change.relativePath,
      change.changeType,
      ...idemTail,
    ],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

/**
 * `ide.diagnostics.reported` — a digest of recurring errors/warnings.
 *
 * Diagnostics are grouped by `(severity, source, code, message)` so a single
 * recurring problem becomes one signature with a count and a capped list of
 * affected files. **Source code is never included.** Messages are redacted
 * when redaction is enabled (a diagnostic message can echo an identifier or
 * a literal).
 */
export function diagnosticsReportedEpisode(
  input: BaseMapInput & { diagnostics: ReadonlyArray<DiagnosticRecord> },
): StatewaveEpisode {
  const groups = new Map<
    string,
    {
      severity: string;
      source?: string;
      code?: string;
      message: string;
      count: number;
      files: Set<string>;
    }
  >();

  for (const d of input.diagnostics) {
    const msg = redactText(d.message, input.redactionEnabled);
    const key = `${d.severity}|${d.source ?? ""}|${d.code ?? ""}|${msg}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        severity: d.severity,
        source: d.source,
        code: d.code,
        message: msg,
        count: 0,
        files: new Set<string>(),
      };
      groups.set(key, g);
    }
    g.count += 1;
    g.files.add(d.relativePath);
  }

  const ordered = [...groups.values()].sort((a, b) => b.count - a.count);
  const severityCounts: Record<string, number> = {};
  for (const d of input.diagnostics) {
    severityCounts[d.severity] = (severityCounts[d.severity] ?? 0) + 1;
  }

  const lines: string[] = [
    `Diagnostics: ${input.diagnostics.length} total across ${groups.size} distinct issue(s).`,
  ];
  for (const g of ordered.slice(0, 30)) {
    const where = [...g.files].sort().slice(0, 8).join(", ");
    const codeTag = g.code ? ` [${g.source ?? ""}${g.code ? `:${g.code}` : ""}]` : "";
    lines.push(`- ×${g.count} ${g.severity}${codeTag}: ${g.message} — ${where}`);
  }

  const stateHash = shortHash(
    ordered.map((g) => `${g.severity}|${g.code}|${g.message}|${g.count}`).join("\n"),
  );

  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.diagnostics.reported",
    text: lines.join("\n"),
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.diagnostics`, id: input.subject },
    metadata: {
      total: input.diagnostics.length,
      distinct: groups.size,
      by_severity: severityCounts,
      state_hash: stateHash,
    },
    idempotency_parts: [
      SOURCE_IDE,
      "diagnostics.reported",
      input.subject,
      stateHash,
    ],
  });
  // text was built from already-redacted messages; this is a no-op safety net.
  return applyRedaction(ep, input.redactionEnabled);
}

function deriveDocTitle(content: string | undefined, fallback: string): string {
  if (content) {
    const m = content.match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return m[1]!.trim();
  }
  return fileTitle(fallback);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…(truncated)`;
}
