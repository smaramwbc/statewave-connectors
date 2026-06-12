import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StatewaveEpisode } from "@statewavedev/connectors-core";
import type { StatewaveClient } from "@statewavedev/mcp-server";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsInt, flagAsString } from "../args.js";
import { dim, green } from "../colors.js";
import { readStatewaveEnv } from "../env.js";
import { Output } from "../output.js";
import { resolveRepoIdentity } from "./repo.js";
import { withSpinner } from "../spinner.js";

// Field/record separators for the git-log dump. ASCII unit (0x1f) and record
// (0x1e) separators never appear in commit text, so multi-line commit bodies
// parse cleanly without quoting games.
const FIELD = "\x1f";
const RECORD = "\x1e";
// git substitutes %x1f / %x1e with the real separator bytes in its output.
const GIT_FORMAT = "--pretty=format:%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e";

const DEFAULT_MAX_COMMITS = 200;
const README_MAX_CHARS = 16_000;
const README_CANDIDATES = ["README.md", "README.markdown", "readme.md", "Readme.md"];

/** Parse the delimited `git log` dump into commit episodes for `subject`. */
export function parseGitLog(raw: string, subject: string): StatewaveEpisode[] {
  const episodes: StatewaveEpisode[] = [];
  for (const record of raw.split(RECORD)) {
    const rec = record.trim();
    if (!rec) continue;
    const [hash, date, author, subjectLine, body = ""] = rec.split(FIELD);
    if (!hash || !subjectLine) continue;
    const trimmedBody = body.trim();
    const text = trimmedBody ? `${subjectLine}\n\n${trimmedBody}` : subjectLine;
    episodes.push({
      subject,
      kind: "git.commit",
      text,
      occurred_at: date || new Date().toISOString(),
      source: { type: "git", id: hash },
      metadata: { author: author || "unknown", sha: hash.slice(0, 10) },
      idempotency_key: `git:commit:${hash}`,
    });
  }
  return episodes;
}

/** Map README contents to a single project-overview episode. */
export function readmeEpisode(content: string, subject: string, occurredAt: string): StatewaveEpisode {
  const text = content.length > README_MAX_CHARS ? content.slice(0, README_MAX_CHARS) : content;
  return {
    subject,
    kind: "repo.readme",
    text,
    occurred_at: occurredAt,
    source: { type: "git", id: "README.md" },
    // Stable key on the subject so re-seeding updates the overview in place
    // rather than piling up a new README episode every run.
    idempotency_key: `git:readme:${subject}`,
  };
}

/** Shell out to git for the recent history. Returns null when this isn't a git repo. */
function collectGitLog(cwd: string, max: number): string | null {
  try {
    return execFileSync(
      "git",
      ["-C", cwd, "log", "-n", String(max), "--no-merges", "--date=iso-strict", GIT_FORMAT],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
}

function readReadme(cwd: string): string | null {
  for (const name of README_CANDIDATES) {
    try {
      const content = readFileSync(resolve(cwd, name), "utf8");
      if (content.trim()) return content;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export async function runMcpSeed(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const repoPath = flagAsString(args, "repo-path");
  const cwd = repoPath ? resolve(repoPath) : process.cwd();
  // Subject from real git identity, not the cwd name. Refuse rather than invent
  // a bogus `repo:<dir>` when there's neither a repo nor an explicit --subject.
  const subject = flagAsString(args, "subject") ?? resolveRepoIdentity(cwd)?.subject;
  if (!subject) {
    out.error(
      "could not determine a memory subject",
      "run inside a git repository, or pass --subject repo:owner/name",
    );
    return 2;
  }
  const maxCommits = flagAsInt(args, "max-commits") ?? DEFAULT_MAX_COMMITS;
  const includeDocs = !flagAsBool(args, "no-docs");
  const write = flagAsBool(args, "write");

  const episodes: StatewaveEpisode[] = [];

  const gitRaw = collectGitLog(cwd, maxCommits);
  const commitEpisodes = gitRaw ? parseGitLog(gitRaw, subject) : [];
  episodes.push(...commitEpisodes);

  let readmeIncluded = false;
  if (includeDocs) {
    const readme = readReadme(cwd);
    if (readme) {
      episodes.push(readmeEpisode(readme, subject, new Date().toISOString()));
      readmeIncluded = true;
    }
  }

  if (episodes.length === 0) {
    out.error(
      "no local signal to seed",
      gitRaw === null
        ? "run this inside a git repository, or seed docs with: statewave-connectors sync markdown --path ./docs"
        : "no commits or README found; seed docs with: statewave-connectors sync markdown --path ./docs",
    );
    return 1;
  }

  const summary = {
    subject,
    commits: commitEpisodes.length,
    readme: readmeIncluded,
    total: episodes.length,
  };

  if (!write) {
    if (out.isJson()) {
      out.data({
        ...summary,
        dry_run: true,
        sample: commitEpisodes.slice(0, 5).map((e) => e.text.split("\n")[0]),
      });
      return 0;
    }
    out.log(`Seed plan for ${subject} (dry run — nothing ingested):`);
    out.log(`  ${commitEpisodes.length} commit episodes`);
    if (readmeIncluded) out.log("  1 README overview episode");
    out.log("");
    out.log("  most recent commits:");
    for (const e of commitEpisodes.slice(0, 5)) {
      out.log(`    • ${e.text.split("\n")[0]}`);
    }
    out.log("");
    out.log("Re-run with --write to ingest and compile so get_context returns real answers.");
    return 0;
  }

  // --write: ingest via the same client the MCP server uses, then compile.
  const env = readStatewaveEnv();
  const url = flagAsString(args, "statewave-url") ?? env.url;
  if (!url) {
    out.error("STATEWAVE_URL is required to ingest", "set STATEWAVE_URL or pass --statewave-url");
    return 2;
  }

  const { StatewaveClient } = await import("@statewavedev/mcp-server");
  const client = new StatewaveClient({ url, apiKey: env.apiKey, tenantId: env.tenantId });

  const concurrency = Math.min(Math.max(flagAsInt(args, "concurrency") ?? 8, 1), 32);
  if (!out.isJson()) {
    out.log(`Ingesting ${episodes.length} episodes into ${subject} (concurrency ${concurrency})…`);
  }
  const { ingested, failed, failures } = await ingestWithProgress(client, episodes, concurrency, out);

  let compiled = false;
  try {
    const result = await withSpinner(
      "Compiling memory… (this can take a moment on a large subject)",
      () => client.compileSubject({ subject }),
      { active: !out.isJson() },
    );
    compiled = result.status === "succeeded" || result.status === "started";
  } catch (err) {
    out.warn(`compile failed: ${(err as Error).message}`);
  }

  if (out.isJson()) {
    out.data({ ...summary, dry_run: false, ingested, failed, compiled });
    return failed > 0 && ingested === 0 ? 1 : 0;
  }

  out.log("");
  out.log(`${green("✓")} Seeded ${subject}:`);
  out.log(`  ingested ${ingested}/${episodes.length} episodes${failed ? ` (${failed} failed)` : ""}`);
  for (const f of failures.slice(0, 5)) out.warn(f);
  if (failures.length > 5) out.log(`  … and ${failures.length - 5} more failures`);
  out.log(`  compiled: ${compiled ? "yes — context is queryable now" : "no — retry, or run a manual compile"}`);
  out.log("");
  out.log("Try it: ask your assistant about this project, or query the subject directly.");
  return failed > 0 && ingested === 0 ? 1 : 0;
}

/**
 * Ingest episodes with bounded concurrency and a live progress indicator. On a
 * TTY it rewrites a single status line; otherwise it logs occasional milestones
 * so piped/CI output still shows movement without spamming. Episodes are
 * independent (each carries its own idempotency_key), so order doesn't matter.
 */
export async function ingestWithProgress(
  client: StatewaveClient,
  episodes: StatewaveEpisode[],
  concurrency: number,
  out: Output,
): Promise<{ ingested: number; failed: number; failures: string[] }> {
  const total = episodes.length;
  const tty = !!process.stdout.isTTY && !out.isJson();
  const failures: string[] = [];
  const milestoneStep = Math.max(1, Math.floor(total / 10));
  let done = 0;
  let ingested = 0;
  let failed = 0;
  let nextMilestone = milestoneStep;

  const report = (): void => {
    if (out.isJson()) return;
    if (tty) {
      const pct = Math.floor((done / total) * 100);
      process.stdout.write(`\r  seeding ${done}/${total} (${pct}%)   `);
    } else if (done >= nextMilestone || done === total) {
      nextMilestone = done + milestoneStep;
      out.log(`  seeded ${done}/${total}…`);
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= total) return;
      const ep = episodes[idx]!;
      try {
        await client.ingestEpisode(ep);
        ingested += 1;
      } catch (err) {
        failed += 1;
        failures.push(`failed to ingest ${ep.source.id}: ${(err as Error).message}`);
      }
      done += 1;
      report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  if (tty) process.stdout.write("\r" + " ".repeat(42) + "\r"); // clear the status line
  return { ingested, failed, failures };
}
