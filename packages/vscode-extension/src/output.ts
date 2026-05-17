import * as vscode from "vscode";
import type { IngestOutcome, StatewaveEpisode } from "@statewavedev/ide-core";

/**
 * A single shared output channel. No telemetry, no remote logging — this
 * writes to the editor's Output panel and nowhere else. The API key is never
 * passed to anything here.
 */
let channel: vscode.OutputChannel | undefined;

export function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Statewave IDE Companion");
  }
  return channel;
}

export function disposeChannel(): void {
  channel?.dispose();
  channel = undefined;
}

export function log(line: string): void {
  getChannel().appendLine(line);
}

/** Render an episode preview into the output channel (dry-run friendly). */
export function previewEpisodes(
  title: string,
  subject: string,
  episodes: ReadonlyArray<StatewaveEpisode>,
): void {
  const ch = getChannel();
  ch.appendLine("");
  ch.appendLine(`── ${title} ──`);
  ch.appendLine(`subject: ${subject}`);
  ch.appendLine(`episodes: ${episodes.length}`);

  const kinds: Record<string, number> = {};
  for (const ep of episodes) kinds[ep.kind] = (kinds[ep.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    ch.appendLine(`  ${k.padEnd(28)} ${n}`);
  }

  const SAMPLE = 12;
  episodes.slice(0, SAMPLE).forEach((ep) => {
    const firstLine = ep.text.split("\n")[0] ?? "";
    ch.appendLine(`  • ${ep.kind} ${ep.source.id} — ${truncate(firstLine, 80)}`);
  });
  if (episodes.length > SAMPLE) {
    ch.appendLine(`  …and ${episodes.length - SAMPLE} more`);
  }
  ch.appendLine(
    "dry-run: nothing was sent. Use the “Ingest” action to send these to Statewave.",
  );
}

export function reportOutcome(outcome: IngestOutcome): void {
  const ch = getChannel();
  if (outcome.dryRun) {
    ch.appendLine(`dry-run complete — ${outcome.attempted} episode(s) previewed.`);
    return;
  }
  ch.appendLine(
    `ingest complete — ${outcome.ingested}/${outcome.attempted} ingested, ${outcome.failed} failed.`,
  );
  if (outcome.errorSample) ch.appendLine(`first error: ${outcome.errorSample}`);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
