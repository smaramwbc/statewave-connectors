import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";
import {
  buildServerSpec,
  CLIENTS,
  type ClientDef,
  findClient,
  jsonEntry,
  renderJsonBlock,
  renderTomlBlock,
  type ServerSpec,
} from "./mcp-clients.js";
import { resolveRepoIdentity } from "./repo.js";

const BEGIN_MARKER = "<!-- statewave:begin (managed by `statewave-connectors mcp init`) -->";
const END_MARKER = "<!-- statewave:end -->";

/**
 * The instruction block dropped into the client's guidance file. This is the
 * behavioral hook: without it the MCP tools are present but the assistant has
 * no reason to call them. Mirrors the proven dogfood pattern — read context
 * first, persist durable facts, never invent results — scoped to one subject.
 */
export function renderInstructionBlock(subject: string, serverName: string): string {
  return [
    BEGIN_MARKER,
    `**Statewave memory** — MCP server \`${serverName}\`, subject \`${subject}\`.`,
    `Before answering questions about this project, call \`${serverName}_get_context\` (that subject, \`query\` = the ask) and ground your answer in it.`,
    `When the user states a durable fact or decision, call \`${serverName}_ingest_episode\` then \`${serverName}_compile_subject\` (same subject). Never invent Statewave results.`,
    END_MARKER,
    "",
  ].join("\n");
}

/**
 * Merge our server entry into an existing JSON config without disturbing other
 * servers. Refuses (throws) on malformed JSON rather than clobbering a file the
 * user hand-edited.
 */
export function mergeJsonConfig(
  existing: string | null,
  spec: ServerSpec,
  client: ClientDef,
): string {
  const containerKey = client.containerKey ?? "mcpServers";
  let root: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      throw new Error(
        `existing ${client.configPath} is not valid JSON (${(err as Error).message}); ` +
          "fix or remove it, then re-run",
      );
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      root = parsed as Record<string, unknown>;
    } else {
      throw new Error(`existing ${client.configPath} is not a JSON object; cannot merge into it`);
    }
  }
  const container =
    root[containerKey] && typeof root[containerKey] === "object" && !Array.isArray(root[containerKey])
      ? (root[containerKey] as Record<string, unknown>)
      : {};
  container[spec.name] = jsonEntry(spec, client);
  root[containerKey] = container;
  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * Append the Codex TOML table if it isn't already present. Appending a fresh
 * `[mcp_servers.<name>]` header at EOF is always valid TOML; the only unsafe
 * case is a duplicate table (a parse error), so we skip when the header already
 * exists rather than risk corrupting a hand-managed file.
 */
export function appendTomlConfig(
  existing: string | null,
  spec: ServerSpec,
): { content: string; skipped: boolean } {
  const header = `[mcp_servers.${spec.name}]`;
  const block = renderTomlBlock(spec);
  if (!existing || !existing.trim()) {
    return { content: block, skipped: false };
  }
  if (existing.includes(header)) {
    return { content: existing, skipped: true };
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return { content: existing + sep + block, skipped: false };
}

/**
 * Idempotently splice the instruction block into a markdown file. If a prior
 * managed block exists (between the markers), replace it; otherwise append.
 */
export function mergeInstruction(existing: string | null, block: string): string {
  if (!existing || !existing.trim()) return block;
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + END_MARKER.length);
    return before + block.trimEnd() + after;
  }
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

interface PlannedFile {
  displayPath: string; // what we show the user (relative or ~-prefixed)
  ioPath: string; // resolved absolute path for read/write
  label: string; // "MCP config" | "instructions"
  block: string; // focused snippet to show in print mode
  nextContent: string; // full file content after the change
  action: "create" | "merge" | "replace" | "skip";
  changed: boolean;
}

function expandUserPath(p: string): string {
  let out = p;
  if (out.startsWith("~/")) out = resolve(homedir(), out.slice(2));
  out = out.replace("%APPDATA%", process.env.APPDATA ?? resolve(homedir(), "AppData/Roaming"));
  return out;
}

function resolveConfigPaths(client: ClientDef, cwd: string): { display: string; io: string } {
  if (client.scope === "user") {
    const raw = client.platformPaths?.[process.platform] ?? client.configPath;
    return { display: raw, io: expandUserPath(raw) };
  }
  return { display: client.configPath, io: resolve(cwd, client.configPath) };
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

interface InitPlan {
  files: PlannedFile[];
  /** Instruction text to paste manually (chat apps with no instruction file). */
  pasteBlock?: string;
}

export interface InitOptions {
  /** Skip the instruction file entirely — write only the MCP server config. */
  skipInstructions?: boolean;
}

async function planInit(
  client: ClientDef,
  spec: ServerSpec,
  subject: string,
  cwd: string,
  opts: InitOptions = {},
): Promise<InitPlan> {
  const files: PlannedFile[] = [];

  // 1. MCP server config
  const cfg = resolveConfigPaths(client, cwd);
  const cfgExisting = await readMaybe(cfg.io);
  if (client.format === "toml") {
    const { content, skipped } = appendTomlConfig(cfgExisting, spec);
    files.push({
      displayPath: cfg.display,
      ioPath: cfg.io,
      label: "MCP config",
      block: renderTomlBlock(spec),
      nextContent: content,
      action: skipped ? "skip" : cfgExisting ? "merge" : "create",
      changed: !skipped && content !== cfgExisting,
    });
  } else {
    const content = mergeJsonConfig(cfgExisting, spec, client);
    files.push({
      displayPath: cfg.display,
      ioPath: cfg.io,
      label: "MCP config",
      block: renderJsonBlock(spec, client),
      nextContent: content,
      action: cfgExisting ? "merge" : "create",
      changed: content !== cfgExisting,
    });
  }

  // 2. Instruction file (project-scoped). Skipped on request; chat apps have
  //    none — return the block as paste-it-yourself guidance instead.
  if (opts.skipInstructions) return { files };
  const block = renderInstructionBlock(subject, spec.name);
  if (!client.instructionFile) {
    return { files, pasteBlock: block };
  }

  const instrIo = resolve(cwd, client.instructionFile);
  const instrExisting = await readMaybe(instrIo);
  const nextInstr = mergeInstruction(instrExisting, block);
  files.push({
    displayPath: client.instructionFile,
    ioPath: instrIo,
    label: "instructions",
    block,
    nextContent: nextInstr,
    action: !instrExisting
      ? "create"
      : instrExisting.includes(BEGIN_MARKER)
        ? "replace"
        : "merge",
    changed: nextInstr !== instrExisting,
  });

  return { files };
}

async function performWrites(
  files: PlannedFile[],
): Promise<Array<{ path: string; action: string }>> {
  const applied: Array<{ path: string; action: string }> = [];
  for (const f of files) {
    if (!f.changed) {
      applied.push({ path: f.displayPath, action: "skip" });
      continue;
    }
    try {
      await mkdir(dirname(f.ioPath), { recursive: true });
      await writeFile(f.ioPath, f.nextContent, "utf8");
      applied.push({ path: f.displayPath, action: f.action });
    } catch (err) {
      throw new Error(`failed to write ${f.displayPath}: ${(err as Error).message}`);
    }
  }
  return applied;
}

/**
 * Plan and apply an init for a caller that already has a `ServerSpec` (e.g.
 * `quickstart`, which builds a spec pointing at its bundled server). Writes the
 * config + instruction files and returns what changed. Throws on write failure.
 */
export async function writeInit(
  client: ClientDef,
  spec: ServerSpec,
  subject: string,
  cwd: string,
  opts: InitOptions = {},
): Promise<{ applied: Array<{ path: string; action: string }>; pasteBlock?: string }> {
  const plan = await planInit(client, spec, subject, cwd, opts);
  const applied = await performWrites(plan.files);
  return { applied, pasteBlock: plan.pasteBlock };
}

export async function runMcpInit(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const cwd = process.cwd();
  const clientId = args.positional[2]; // ["mcp", "init", "<client>"]

  if (!clientId) {
    if (out.isJson()) {
      out.data({ clients: CLIENTS.map((c) => ({ id: c.id, label: c.label, scope: c.scope })) });
      return 0;
    }
    out.log("statewave-connectors mcp init <client> [--write]");
    out.log("");
    out.log("supported clients:");
    for (const c of CLIENTS) {
      out.log(`  ${c.id.padEnd(8)} ${c.label}  (${c.configPath})`);
    }
    out.log("");
    out.log("Prints the MCP config + instruction block by default; pass --write to apply.");
    return 0;
  }

  const client = findClient(clientId);
  if (!client) {
    out.error(
      `unknown client: ${clientId}`,
      `supported: ${CLIENTS.map((c) => c.id).join(", ")}`,
    );
    return 2;
  }

  const spec = buildServerSpec({
    name: flagAsString(args, "name"),
    statewaveUrl: flagAsString(args, "statewave-url"),
    tenantId: flagAsString(args, "tenant"),
    serverBin: flagAsString(args, "server-bin"),
    serverCommand: flagAsString(args, "server-command"),
  });
  // Prefer real git identity (remote → repo:owner/name); fall back to the
  // directory name only when this isn't a git work-tree, since init still writes
  // client config regardless of repo.
  const subject = flagAsString(args, "subject") ?? resolveRepoIdentity(cwd)?.subject ?? `repo:${basename(cwd)}`;
  const write = flagAsBool(args, "write");
  const skipInstructions = flagAsBool(args, "no-instructions");

  let plan: InitPlan;
  try {
    plan = await planInit(client, spec, subject, cwd, { skipInstructions });
  } catch (err) {
    out.error((err as Error).message);
    return 1;
  }
  const { files, pasteBlock } = plan;

  if (write) {
    let applied: Array<{ path: string; action: string }>;
    try {
      applied = await performWrites(files);
    } catch (err) {
      out.error((err as Error).message);
      return 1;
    }
    if (out.isJson()) {
      out.data({ client: client.id, subject, server: spec.name, files: applied, paste_instructions: pasteBlock });
      return 0;
    }
    out.log(`Configured ${client.label} for Statewave (server id: ${spec.name}).`);
    out.log("");
    for (const a of applied) {
      const tag = a.action === "skip" ? "unchanged" : a.action === "create" ? "created" : "updated";
      out.log(`  ${tag.padEnd(9)} ${a.path}`);
    }
    if (pasteBlock) printPasteBlock(out, pasteBlock);
    printNextSteps(out, client, spec, subject);
    return 0;
  }

  // Print-only (default): show exactly what `--write` would do, change nothing.
  if (out.isJson()) {
    out.data({
      client: client.id,
      subject,
      server: spec.name,
      files: files.map((f) => ({ path: f.displayPath, action: f.action, block: f.block })),
      paste_instructions: pasteBlock,
    });
    return 0;
  }

  out.log(`Statewave MCP setup for ${client.label} (server id: ${spec.name}, subject: ${subject})`);
  out.log("");
  for (const f of files) {
    out.log(`# ${f.label} → ${f.displayPath}  (${f.action})`);
    out.log(f.block.trimEnd());
    out.log("");
  }
  if (pasteBlock) printPasteBlock(out, pasteBlock);
  out.log("Nothing was written. Re-run with --write to apply, or paste the blocks above.");
  printNextSteps(out, client, spec, subject);
  return 0;
}

function printPasteBlock(out: Output, block: string): void {
  out.log("# instructions → paste into your assistant's custom instructions (chat app, no repo file)");
  out.log(block.trimEnd());
  out.log("");
}

function printNextSteps(out: Output, client: ClientDef, spec: ServerSpec, subject: string): void {
  out.log("");
  out.log("next steps:");
  out.log(`  1. Start your Statewave server and confirm it's reachable at ${spec.env.STATEWAVE_URL}.`);
  out.log(`  2. ${client.note}`);
  out.log(`  3. Seed memory so context isn't empty: statewave-connectors mcp seed --subject ${subject} --write`);
  out.log("  4. Ask your assistant about the project — it will call statewave_get_context first.");
}
