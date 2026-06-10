/**
 * Pure derivation of the status-bar model. The extension renders this; all
 * the "what should the user see" logic lives here and is unit-tested so the
 * trust surface is deterministic.
 */
import type { CompileState } from "./compile-scheduler.js";

export type StatusPhase =
  | "initializing"
  | "indexing"
  | "syncing"
  | "idle";

export interface StatusInputs {
  phase: StatusPhase;
  /** undefined = unknown/not checked yet; false = unreachable. */
  online?: boolean;
  /**
   * A reachability probe is in flight right now. When the server is not yet
   * known-online, this surfaces as "connecting…" instead of "offline", so the
   * user sees the offline → connecting → online progression on recovery
   * rather than a status stuck on "offline".
   */
  reconnecting?: boolean;
  /** Compiled-memory count for the subject, if known. */
  memories?: number;
  compile: CompileState;
  /** Count of recent non-fatal errors (ingest failures, write failures…). */
  errors: number;
  /** Resolved subject, for the tooltip. */
  subject?: string;
  /**
   * `true` iff a subject was attempted and the resolver returned null —
   * an open folder with no parseable git remote under the `repo` strategy,
   * or `custom` strategy with no `statewave.subject` set. Surfaced in the
   * status bar text the same way `offline` is, because nothing else
   * works until it's resolved.
   */
  subjectFailed?: boolean;
}

export type StatusKind = "normal" | "warning" | "error";

export interface StatusModel {
  /** Short status-bar label (caller prefixes the brain glyph). */
  text: string;
  /** Hover tooltip (multi-line). */
  tooltip: string;
  kind: StatusKind;
}

export function deriveStatus(s: StatusInputs): StatusModel {
  const lines: string[] = [];
  if (s.subject) {
    lines.push(`Subject: ${s.subject}`);
  } else if (s.subjectFailed) {
    lines.push(
      "Subject: unresolved — open a folder with a git remote, or change `statewave.subjectStrategy` (auto / workspace), or set `statewave.subject` explicitly.",
    );
  }
  lines.push(
    `Server: ${
      s.reconnecting && s.online !== true
        ? "connecting…"
        : s.online === false
          ? "unreachable"
          : s.online
            ? "online"
            : "unknown"
    }`,
  );
  lines.push(
    `Memory: ${typeof s.memories === "number" ? `${s.memories} compiled` : "unknown"}`,
  );
  lines.push(`Compile: ${s.compile}`);
  if (s.errors > 0) lines.push(`Recent errors: ${s.errors}`);
  lines.push("Click for actions & diagnostics.");
  const tooltip = lines.join("\n");

  // A probe in flight while not yet known-online reads as "connecting…",
  // not "offline" — this is what turns a stuck "offline" into the
  // offline → connecting → online progression the user expects on recovery.
  if (s.reconnecting && s.online !== true) {
    return { text: "Statewave connecting…", tooltip, kind: "normal" };
  }
  if (s.online === false) {
    return { text: "Statewave offline", tooltip, kind: "error" };
  }
  // Subject failure surfaces as an error in the status bar text — same
  // class as `offline`, because nothing meaningful works without a
  // resolved subject. Placed after the server checks (server problems
  // are more fundamental) but before phase/compile/memories so it isn't
  // shadowed by a stale "memories ready" from a previous workspace.
  if (s.subjectFailed) {
    return { text: "Statewave: subject unresolved", tooltip, kind: "error" };
  }
  if (s.errors > 0) {
    return { text: `Statewave: ${s.errors} error(s)`, tooltip, kind: "error" };
  }
  if (s.phase === "initializing") {
    return { text: "Statewave starting…", tooltip, kind: "normal" };
  }
  if (s.phase === "indexing") {
    return { text: "Statewave indexing…", tooltip, kind: "normal" };
  }
  if (s.phase === "syncing") {
    return { text: "Statewave syncing…", tooltip, kind: "normal" };
  }
  if (s.compile === "compiling") {
    return { text: "Statewave compiling…", tooltip, kind: "normal" };
  }
  if (s.compile === "pending") {
    return { text: "Statewave: compile pending", tooltip, kind: "warning" };
  }
  if (s.compile === "failed") {
    return { text: "Statewave: compile failed", tooltip, kind: "error" };
  }
  if (typeof s.memories === "number") {
    return {
      text: `Statewave: ${s.memories} memories ready`,
      tooltip,
      kind: "normal",
    };
  }
  return { text: "Statewave ready", tooltip, kind: "normal" };
}
