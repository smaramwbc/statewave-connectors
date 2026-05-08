import { EpisodeBuilder, type StatewaveEpisode } from "@statewave/connectors-core";
import type { ScannedFile } from "./scanner.js";

export type MarkdownEpisodeKind = "docs.page" | "docs.decision" | "docs.adr" | "docs.rfc";

export interface MarkdownMapOptions {
  subject: string;
  rootName?: string;
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

export function detectKind(relativePath: string): MarkdownEpisodeKind {
  const lower = relativePath.toLowerCase();
  if (/(?:^|\/)adrs?(?:\/|[-_])/.test(lower) || /(?:^|\/)adr-?\d/.test(lower)) return "docs.adr";
  if (/(?:^|\/)rfcs?(?:\/|[-_])/.test(lower) || /(?:^|\/)rfc-?\d/.test(lower)) return "docs.rfc";
  if (lower.includes("decision")) return "docs.decision";
  if (lower.includes("architecture")) return "docs.decision";
  return "docs.page";
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: content };
  const data = parseSimpleYaml(match[1]!);
  return { data, body: match[2] ?? "" };
}

function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => v.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function mapMarkdownFile(file: ScannedFile, options: MarkdownMapOptions): StatewaveEpisode {
  const { data, body } = parseFrontmatter(file.content);
  const kind = detectKind(file.relativePath);
  const title = (data.title as string | undefined) ?? deriveTitle(body, file.relativePath);
  const occurred = (data.date as string | undefined) ?? file.mtime;

  const builder = new EpisodeBuilder({
    subject: options.subject,
  });

  return builder.build({
    kind,
    text: composeText(title, body),
    occurred_at: occurred,
    source: {
      type: "markdown",
      id: file.relativePath,
      url: `file://${file.absolutePath}`,
    },
    metadata: {
      path: file.relativePath,
      hash: file.hash,
      size: file.size,
      title,
      frontmatter: Object.keys(data).length > 0 ? data : undefined,
    },
    idempotency_parts: ["markdown", options.subject, file.relativePath, file.hash],
  });
}

function deriveTitle(body: string, fallback: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*$/m);
  if (m) return m[1]!.trim();
  return fallback;
}

function composeText(title: string, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return title;
  if (trimmed.startsWith(`# ${title}`)) return trimmed;
  return `# ${title}\n\n${trimmed}`;
}
