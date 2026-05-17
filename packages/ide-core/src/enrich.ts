import { createHash } from "node:crypto";
import {
  EpisodeBuilder,
  type StatewaveEpisode,
} from "@statewavedev/connectors-core";
import { mapMarkdownFile, type ScannedFile } from "@statewavedev/connectors-markdown";
import { applyRedaction } from "./redaction.js";
import type { BaseMapInput } from "./episodes.js";

/**
 * Richer-detail episode mappers — docs *content* (not just a digest), git
 * *history* (not just current branch), and a lightweight *code structure*
 * map (symbols/signatures, never full source bodies).
 *
 * Same rules as `episodes.ts`: built via `EpisodeBuilder`, content-addressable
 * idempotency, redaction applied last.
 */

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

const SOURCE_IDE = "ide";

/**
 * Full document-content episodes. Reuses the existing
 * `@statewavedev/connectors-markdown` mapper so README / docs / ADR / RFC
 * bodies land as the same `docs.page|docs.adr|docs.rfc|docs.decision`
 * episodes the Markdown connector produces — frontmatter parsing, H1 title,
 * and content-hash idempotency included, no parallel implementation.
 */
export function docsContentEpisodes(
  input: BaseMapInput & { docs: ReadonlyArray<ScannedFile> },
): StatewaveEpisode[] {
  return input.docs.map((file) => {
    const ep = mapMarkdownFile(file, { subject: input.subject });
    const dated = input.occurredAt ? { ...ep, occurred_at: input.occurredAt } : ep;
    return applyRedaction(dated, input.redactionEnabled);
  });
}

export interface GitCommit {
  hash: string;
  authorName?: string;
  authorEmail?: string;
  date?: string;
  message: string;
}

/**
 * `ide.git.history` — a digest of recent commits. Idempotent on the set of
 * commit hashes, so re-running on an unchanged history dedupes and new
 * commits produce a new memory.
 */
export function gitHistoryEpisode(
  input: BaseMapInput & { commits: ReadonlyArray<GitCommit> },
): StatewaveEpisode {
  const commits = input.commits;
  const lines = [`Recent git history (${commits.length} commit(s), newest first):`];
  for (const c of commits.slice(0, 100)) {
    const subjectLine = c.message.split("\n")[0] ?? "";
    const who = c.authorName ? ` — ${c.authorName}` : "";
    const when = c.date ? ` (${c.date})` : "";
    lines.push(`- ${c.hash.slice(0, 12)} ${subjectLine}${who}${when}`);
  }
  const stateHash = shortHash(commits.map((c) => c.hash).join(","));
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.git.history",
    text: lines.join("\n"),
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.git`, id: `${input.subject}:history` },
    metadata: {
      commit_count: commits.length,
      newest: commits[0]?.hash,
      oldest: commits[commits.length - 1]?.hash,
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "git.history", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}

export interface CodeSymbol {
  name: string;
  /** Human label of the symbol kind (function, class, method, …). */
  kind: string;
  line: number;
}
export interface CodeFileStructure {
  relativePath: string;
  /** Short content hash of the file (for idempotency only). */
  hash: string;
  symbols: ReadonlyArray<CodeSymbol>;
}

/**
 * `ide.code.structure` — a lightweight structural map: per source file, its
 * top-level symbols (name + kind + line). **No source bodies.** This gives
 * the assistant project-shape awareness without the volume/privacy cost of
 * dumping code that it already sees in-context. Idempotent on the combined
 * file+symbol fingerprint.
 */
export function codeStructureEpisode(
  input: BaseMapInput & { files: ReadonlyArray<CodeFileStructure> },
): StatewaveEpisode {
  const files = [...input.files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  const lines: string[] = [
    `Code structure — ${files.length} file(s), symbols only (no source):`,
  ];
  let symbolTotal = 0;
  for (const f of files) {
    lines.push(`\n${f.relativePath}`);
    for (const s of f.symbols.slice(0, 60)) {
      symbolTotal += 1;
      lines.push(`  ${s.kind} ${s.name}:${s.line}`);
    }
  }
  const fingerprint = files
    .map((f) => `${f.relativePath}:${f.hash}:${f.symbols.length}`)
    .join("\n");
  const stateHash = shortHash(fingerprint);
  const ep = new EpisodeBuilder({ subject: input.subject }).build({
    kind: "ide.code.structure",
    text: lines.join("\n"),
    occurred_at: input.occurredAt,
    source: { type: `${SOURCE_IDE}.code`, id: `${input.subject}:structure` },
    metadata: {
      file_count: files.length,
      symbol_count: symbolTotal,
      state_hash: stateHash,
    },
    idempotency_parts: [SOURCE_IDE, "code.structure", input.subject, stateHash],
  });
  return applyRedaction(ep, input.redactionEnabled);
}
