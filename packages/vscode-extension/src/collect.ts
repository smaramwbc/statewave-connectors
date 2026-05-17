import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import type {
  GitCommit,
  CodeFileStructure,
  CodeSymbol,
  ScannedWorkspaceFile,
} from "@statewavedev/ide-core";
import { log } from "./output.js";

const GIT_MAX_COMMITS = 100;
const CODE_MAX_FILES = 250;
const DOC_MAX_BYTES = 256 * 1024;

/**
 * Recent git history via the built-in VS Code Git extension API — no `git`
 * spawn, no `.git` parsing. Returns [] when the Git extension is absent,
 * disabled, or the folder isn't a repo.
 */
export async function collectGitHistory(root: string): Promise<GitCommit[]> {
  try {
    const ext = vscode.extensions.getExtension<{
      getAPI(v: 1): GitApi;
    }>("vscode.git");
    if (!ext) return [];
    const git = (await ext.activate()).getAPI(1);
    const repo =
      git.getRepository(vscode.Uri.file(root)) ??
      git.repositories.find((r) => root.startsWith(r.rootUri.fsPath));
    if (!repo) return [];
    const commits = await repo.log({ maxEntries: GIT_MAX_COMMITS });
    return commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      date: c.authorDate ? new Date(c.authorDate).toISOString() : undefined,
    }));
  } catch (err) {
    log(`collect: git history unavailable (${(err as Error).message})`);
    return [];
  }
}

const SYMBOL_KIND: Record<number, string> = {
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.Struct]: "struct",
};

/**
 * Lightweight code structure: top-level symbols per source file via the
 * language server's symbol provider (no custom parser, no source bodies).
 * Capped; best-effort per file.
 */
export async function collectCodeStructure(
  files: ReadonlyArray<ScannedWorkspaceFile>,
): Promise<CodeFileStructure[]> {
  const source = files
    .filter((f) => f.category === "source")
    .slice(0, CODE_MAX_FILES);
  const out: CodeFileStructure[] = [];

  for (const f of source) {
    try {
      const uri = vscode.Uri.file(f.absolutePath);
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[]
      >("vscode.executeDocumentSymbolProvider", uri);
      if (!symbols || symbols.length === 0) continue;
      const mapped: CodeSymbol[] = [];
      for (const s of symbols) {
        const range =
          (s as vscode.DocumentSymbol).range ??
          (s as vscode.SymbolInformation).location?.range;
        mapped.push({
          name: s.name,
          kind: SYMBOL_KIND[s.kind] ?? "symbol",
          line: (range?.start.line ?? 0) + 1,
        });
      }
      if (mapped.length > 0) {
        out.push({ relativePath: f.relativePath, hash: f.hash, symbols: mapped });
      }
    } catch {
      // No symbol provider for this language/file — skip silently.
    }
  }
  return out;
}

/**
 * Read content for documentation files (size-capped) into the
 * `ScannedFile` shape the Markdown connector mapper consumes.
 */
export async function collectDocContents(
  docs: ReadonlyArray<ScannedWorkspaceFile>,
): Promise<
  Array<{
    absolutePath: string;
    relativePath: string;
    hash: string;
    size: number;
    mtime: string;
    content: string;
  }>
> {
  const out: Array<{
    absolutePath: string;
    relativePath: string;
    hash: string;
    size: number;
    mtime: string;
    content: string;
  }> = [];
  for (const f of docs) {
    if (f.size > DOC_MAX_BYTES) continue;
    try {
      out.push({
        absolutePath: f.absolutePath,
        relativePath: f.relativePath,
        hash: f.hash,
        size: f.size,
        mtime: f.mtime,
        content: await fs.readFile(f.absolutePath, "utf8"),
      });
    } catch {
      /* unreadable → skip */
    }
  }
  return out;
}

// Minimal shape of the built-in Git extension API we use.
interface GitApi {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitRepository {
  rootUri: vscode.Uri;
  log(options?: { maxEntries?: number }): Promise<GitCommitRaw[]>;
}
interface GitCommitRaw {
  hash: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: Date;
}
