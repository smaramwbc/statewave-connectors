import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAgentInstruction,
  wrapForClient,
  mergeMarkedBlock,
  stripMarkedBlock,
  resolveSubject,
  readGitContext,
  resolveActiveClients,
  editorKind,
  AGENT_INSTRUCTION_TARGETS,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { log } from "./output.js";

function hasExt(...idFragments: string[]): boolean {
  const wanted = idFragments.map((s) => s.toLowerCase());
  return vscode.extensions.all.some((e) => {
    const id = e.id.toLowerCase();
    return wanted.some((w) => id === w);
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which assistants are actually present here. An instruction file is only
 * worth writing if its client is real — otherwise a plain-VS-Code user gets
 * `.cursor/`, `.windsurf/`, `.roo/`, … rule files for editors they never run.
 */
export async function detectActiveClients(): Promise<ReadonlyArray<string>> {
  const home = os.homedir();
  return resolveActiveClients({
    editor: editorKind(vscode.env.uriScheme, vscode.env.appName),
    hasCopilot: hasExt("github.copilot", "github.copilot-chat"),
    hasClaudeCode:
      hasExt("anthropic.claude-code") ||
      (await fileExists(path.join(home, ".claude.json"))),
    hasCline: hasExt("saoudrizwan.claude-dev"),
    hasRoo: hasExt("rooveterinaryinc.roo-cline"),
    hasContinue:
      hasExt("continue.continue") ||
      (await fileExists(path.join(home, ".continue"))),
  });
}

/**
 * Write the reflexive read+write instruction file for every allowed client.
 *
 * These files carry no secrets (behaviour text + the non-secret subject), so
 * unlike MCP config they belong in the repo and are safe to commit/share.
 * "own" clients get a file we fully control (idempotent by content); shared
 * files (Copilot/Claude) get a delimited block that never disturbs the
 * user's own content. Best-effort; never throws.
 */
export async function syncAgentInstructions(): Promise<{ wired: string[] }> {
  const cfg = readConfig();
  if (cfg.assistantInstructions === "off") return { wired: [] };

  const folder = primaryWorkspaceFolder();
  if (!folder) return { wired: [] };

  const git = await readGitContext(folder.uri.fsPath);
  const subject = resolveSubject({
    config: cfg,
    remoteUrl: git.remoteUrl,
    folderName: folder.name,
  });
  if (!subject) return { wired: [] };

  const body = buildAgentInstruction({ subject, mode: cfg.assistantInstructions });
  // Write only for clients that are (a) actually present here and
  // (b) allowed by statewave.mcp.clients. No more repo pollution.
  const active = new Set(await detectActiveClients());
  const allow = new Set(cfg.mcpClients);
  const wired: string[] = [];

  for (const t of AGENT_INSTRUCTION_TARGETS) {
    if (!active.has(t.client) || !allow.has(t.client)) continue;
    const abs = path.join(folder.uri.fsPath, t.relativePath);
    try {
      if (t.strategy === "own") {
        const desired = wrapForClient(t.client, body);
        let cur: string | undefined;
        try {
          cur = await fs.readFile(abs, "utf8");
        } catch {
          cur = undefined;
        }
        if (cur === desired) continue;
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, desired, "utf8");
      } else {
        let existing = "";
        try {
          existing = await fs.readFile(abs, "utf8");
        } catch {
          existing = "";
        }
        const { content, changed } = mergeMarkedBlock(existing, body);
        if (!changed) continue;
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
      }
      wired.push(t.client);
      log(`instructions: wrote ${t.relativePath} (${cfg.assistantInstructions})`);
    } catch (err) {
      log(`instructions: could not write ${t.relativePath}: ${(err as Error).message}`);
    }
  }
  return { wired };
}

/**
 * Reset: remove the instruction files/blocks we manage. "own" files we wrote
 * are deleted; in shared files (Copilot/Claude) only our delimited block is
 * stripped — the user's own content is preserved. Best-effort.
 */
export async function removeInstructionFiles(): Promise<string[]> {
  const folder = primaryWorkspaceFolder();
  if (!folder) return [];
  const removed: string[] = [];
  for (const t of AGENT_INSTRUCTION_TARGETS) {
    const abs = path.join(folder.uri.fsPath, t.relativePath);
    try {
      if (t.strategy === "own") {
        await fs.rm(abs, { force: true });
        removed.push(t.relativePath);
      } else {
        let existing = "";
        try {
          existing = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        const { content, changed } = stripMarkedBlock(existing);
        if (changed) {
          await fs.writeFile(abs, content, "utf8");
          removed.push(`${t.relativePath} (block)`);
        }
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
