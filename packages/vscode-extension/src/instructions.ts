import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  buildAgentInstruction,
  wrapForClient,
  mergeMarkedBlock,
  resolveSubject,
  readGitContext,
  AGENT_INSTRUCTION_TARGETS,
} from "@statewavedev/ide-core";
import { readConfig, primaryWorkspaceFolder } from "./config.js";
import { log } from "./output.js";

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
  const allow = new Set(cfg.mcpClients);
  const wired: string[] = [];

  for (const t of AGENT_INSTRUCTION_TARGETS) {
    if (!allow.has(t.client)) continue;
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
