/**
 * Reflexive read+write agent instructions.
 *
 * This is the lever that makes the project brain *invisible*: a small,
 * client-appropriate rules file tells the assistant to (a) consult
 * `statewave_get_context` before answering project questions, and (b) persist
 * durable user-stated facts via `statewave_ingest_episode`.
 *
 * Crucial principle: the plugin still never reads the assistant's chat. The
 * assistant itself decides what is salient and calls the public MCP tool —
 * visible and approvable. These instruction files contain no secrets (only
 * behaviour text + the non-secret subject), so unlike MCP config they belong
 * in the repo and are safe to commit/share with the team.
 *
 * Pure + dependency-free; the editor host does the file I/O.
 */

export type InstructionMode = "read-write" | "read-only";

export const STATEWAVE_BEGIN = "<!-- statewave:begin (auto-managed — edits here are overwritten) -->";
export const STATEWAVE_END = "<!-- statewave:end -->";

export function buildAgentInstruction(input: {
  subject: string;
  mode: InstructionMode;
}): string {
  const s = input.subject;
  const lines: string[] = [
    "# Statewave project memory",
    "",
    "This workspace has a Statewave “project brain” exposed over MCP (server id: " +
      "`statewave`). It holds this project's summary, conventions, documentation, git " +
      `history, code structure and remembered facts, scoped to subject \`${s}\`.`,
    "",
    "## Read it first",
    "",
    "Before answering questions about THIS project — conventions, architecture, " +
      "history, structure, prior decisions, “how/why does X work”, “what changed” — " +
      `call the \`statewave_get_context\` MCP tool (subject \`${s}\`, \`query\` = the ` +
      "user's ask) and ground your answer in what it returns. Prefer it over guessing " +
      "or re-deriving from scratch.",
  ];
  if (input.mode === "read-write") {
    lines.push(
      "",
      "## Persist durable facts",
      "",
      "When the user states a durable preference, decision, or fact worth remembering " +
        "across sessions (e.g. “my favorite color is red”, “we use X for Y”, " +
        "“always do Z here”), call the `statewave_ingest_episode` MCP tool " +
        `(subject \`${s}\`, kind \`chat.note\`, text = the fact). Capture stable ` +
        "facts/preferences/decisions only — not transient chatter, and not code you " +
        "are about to write. The user sees and can approve each tool call.",
      "",
      "Immediately after a successful `statewave_ingest_episode`, call the " +
        `\`statewave_compile_subject\` MCP tool (subject \`${s}\`). An ingested ` +
        "episode is raw and not yet retrievable; compiling distils it into the " +
        "durable memory that `statewave_get_context` returns next time.",
    );
  }
  lines.push(
    "",
    "Never invent Statewave results; if the tool is unavailable, say so plainly.",
  );
  return lines.join("\n");
}

/** Frontmatter wrapper per client for the standalone-file ("own") clients. */
export function wrapForClient(client: string, body: string): string {
  switch (client) {
    case "cursor":
      return `---\nalwaysApply: true\n---\n\n${body}\n`;
    case "windsurf":
      return `---\ntrigger: always_on\n---\n\n${body}\n`;
    case "continue":
      return `---\nname: Statewave Project Memory\nalwaysApply: true\n---\n\n${body}\n`;
    // cline / roo: plain markdown (no frontmatter ⇒ always active)
    default:
      return `${body}\n`;
  }
}

export interface MarkedMergeResult {
  content: string;
  changed: boolean;
}

/**
 * Insert/replace our delimited block in a shared instruction file
 * (Copilot `.github/copilot-instructions.md`, Claude `CLAUDE.md`), preserving
 * everything the user wrote outside the markers. Idempotent.
 */
export function mergeMarkedBlock(
  existing: string,
  body: string,
): MarkedMergeResult {
  const block = `${STATEWAVE_BEGIN}\n${body}\n${STATEWAVE_END}`;
  const prev = existing ?? "";
  const begin = prev.indexOf(STATEWAVE_BEGIN);
  const end = prev.indexOf(STATEWAVE_END);

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = prev.slice(0, begin);
    const after = prev.slice(end + STATEWAVE_END.length);
    const next = `${before}${block}${after}`;
    return { content: next, changed: next !== prev };
  }
  const sep = prev.length === 0 ? "" : prev.endsWith("\n") ? "\n" : "\n\n";
  const next = `${prev}${sep}${block}\n`;
  return { content: next, changed: true };
}

/** Where each client's instruction file lives + how we manage it. */
export interface InstructionTarget {
  client: string;
  /** Workspace-relative path. */
  relativePath: string;
  /** "own" = we fully control the file; "merge" = delimited block in a shared file. */
  strategy: "own" | "merge";
}

export const AGENT_INSTRUCTION_TARGETS: ReadonlyArray<InstructionTarget> = [
  { client: "copilot", relativePath: ".github/copilot-instructions.md", strategy: "merge" },
  { client: "claude", relativePath: "CLAUDE.md", strategy: "merge" },
  { client: "cursor", relativePath: ".cursor/rules/statewave.mdc", strategy: "own" },
  { client: "windsurf", relativePath: ".windsurf/rules/statewave.md", strategy: "own" },
  { client: "cline", relativePath: ".clinerules/statewave.md", strategy: "own" },
  { client: "roo", relativePath: ".roo/rules/statewave.md", strategy: "own" },
  { client: "continue", relativePath: ".continue/rules/statewave.md", strategy: "own" },
];
