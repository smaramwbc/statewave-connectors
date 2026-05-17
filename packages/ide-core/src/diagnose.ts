/**
 * Pure diagnostics formatter. The extension probes the environment and fills
 * this bag; this turns it into a human-readable report with actionable
 * fixes. Pure → the advice is deterministic and unit-tested.
 */
import type { CompileState } from "./compile-scheduler.js";

export interface DiagnoseProbe {
  serverUrl?: string;
  serverReachable?: boolean;
  authValid?: boolean;
  subject?: string | null;
  subjectStrategy: string;
  mcpProviderRegistered: boolean;
  mcpClientsWired: ReadonlyArray<string>;
  instructionClients: ReadonlyArray<string>;
  watcherActive: boolean;
  autoIndex: boolean;
  redactionEnabled: boolean;
  lastBuildAt?: number;
  lastCompile: CompileState;
  indexedCount?: number;
  skippedCount?: number;
}

export interface DiagnoseFinding {
  severity: "ok" | "warn" | "error";
  message: string;
  fix?: string;
}

export interface DiagnoseReport {
  ok: boolean;
  findings: DiagnoseFinding[];
  /** Rendered plain-text report (for the output channel / copy button). */
  text: string;
}

function rel(ts?: number, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function diagnose(p: DiagnoseProbe, now = Date.now()): DiagnoseReport {
  const f: DiagnoseFinding[] = [];

  if (!p.serverUrl) {
    f.push({
      severity: "error",
      message: "No Statewave URL configured.",
      fix: "Set `statewave.url` (defaults to http://localhost:8100) or run “Statewave: Configure Statewave”.",
    });
  } else if (p.serverReachable === false) {
    f.push({
      severity: "error",
      message: `Statewave server unreachable at ${p.serverUrl}.`,
      fix: "Start your Statewave instance, or fix `statewave.url`. Diagnose again once it's up.",
    });
  } else if (p.serverReachable) {
    f.push({ severity: "ok", message: `Server reachable at ${p.serverUrl}.` });
  }

  if (p.serverReachable && p.authValid === false) {
    f.push({
      severity: "error",
      message: "Server rejected the API key (401).",
      fix: "Set a valid `statewave.apiKey` in your User settings.",
    });
  }

  if (!p.subject) {
    f.push({
      severity: "error",
      message: `Could not resolve a subject (strategy: ${p.subjectStrategy}).`,
      fix: "Open a folder with a git remote, or set `statewave.subject`, or use the `auto`/`workspace` strategy.",
    });
  } else {
    f.push({ severity: "ok", message: `Subject: ${p.subject}` });
  }

  f.push(
    p.mcpProviderRegistered
      ? { severity: "ok", message: "VS Code MCP provider registered (Copilot zero-config)." }
      : {
          severity: "warn",
          message: "VS Code MCP provider API not available (older editor).",
          fix: "Update VS Code to ≥1.101 for zero-config Copilot, or configure MCP manually (docs/ide-memory.md).",
        },
  );

  f.push(
    p.mcpClientsWired.length > 0
      ? { severity: "ok", message: `MCP wired: ${p.mcpClientsWired.join(", ")}.` }
      : {
          severity: "warn",
          message: "No file-based MCP clients wired.",
          fix: "Install Cursor/Windsurf/Claude Code/Cline/Roo/Continue, or rely on the in-memory Copilot provider.",
        },
  );

  f.push(
    p.instructionClients.length > 0
      ? { severity: "ok", message: `Instruction files for: ${p.instructionClients.join(", ")}.` }
      : {
          severity: "warn",
          message: "No assistant instruction files written (no client detected).",
          fix: "Install an assistant extension, or set `statewave.assistantInstructions`.",
        },
  );

  if (p.lastCompile === "failed") {
    f.push({
      severity: "error",
      message: "Last compile failed.",
      fix: "Run “Statewave: Compile Project Memory” and check the output channel for the server error.",
    });
  } else if (p.lastCompile === "pending") {
    f.push({
      severity: "warn",
      message: "A compile is pending — recent episodes aren't queryable memory yet.",
      fix: "It will run shortly; or run “Statewave: Compile Project Memory” now.",
    });
  } else if (p.lastCompile === "ready") {
    f.push({ severity: "ok", message: "Memory compiled and queryable." });
  }

  f.push({
    severity: "ok",
    message: `Build ${rel(p.lastBuildAt, now)} · indexed ${p.indexedCount ?? "?"} · skipped ${p.skippedCount ?? "?"} · watcher ${p.watcherActive ? "on" : "off"} · autoIndex ${p.autoIndex ? "on" : "off"} · redaction ${p.redactionEnabled ? "on" : "off"}.`,
  });

  const ok = !f.some((x) => x.severity === "error");
  const text = [
    `Statewave Diagnose — ${ok ? "OK" : "ACTION NEEDED"}`,
    "",
    ...f.map((x) => {
      const tag = x.severity === "ok" ? "[ok]  " : x.severity === "warn" ? "[warn]" : "[err] ";
      return `${tag} ${x.message}${x.fix ? `\n        ↳ ${x.fix}` : ""}`;
    }),
  ].join("\n");

  return { ok, findings: f, text };
}
