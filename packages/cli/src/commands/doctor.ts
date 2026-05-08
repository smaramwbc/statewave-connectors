import type { ParsedArgs } from "../args.js";
import { readStatewaveEnv } from "../env.js";
import { Output } from "../output.js";
import { flagAsBool } from "../args.js";
import { CLI_VERSION } from "../version.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "error";
  message?: string;
}

export async function runDoctor(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const env = readStatewaveEnv();

  const checks: Check[] = [
    {
      name: "STATEWAVE_URL",
      status: env.url ? "ok" : "warn",
      message: env.url ?? "not set — sync will require STATEWAVE_URL or non-dry-run will refuse to ingest",
    },
    {
      name: "STATEWAVE_API_KEY",
      status: env.apiKey ? "ok" : "warn",
      message: env.apiKey ? "set" : "not set — only required if your Statewave instance enforces auth",
    },
    {
      name: "STATEWAVE_TENANT_ID",
      status: env.tenantId ? "ok" : "warn",
      message: env.tenantId ? "set" : "not set — only required for multi-tenant deployments",
    },
    {
      name: "GITHUB_TOKEN",
      status: process.env.GITHUB_TOKEN ? "ok" : "warn",
      message: process.env.GITHUB_TOKEN
        ? "set — GitHub connector will use authenticated requests"
        : "not set — only required to use the GitHub connector",
    },
  ];

  const overall: Check["status"] = checks.some((c) => c.status === "error")
    ? "error"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

  const versions = {
    cli: CLI_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };

  if (out.isJson()) {
    out.data({ status: overall, versions, checks });
    return overall === "error" ? 1 : 0;
  }

  out.log(`statewave-connectors doctor — ${overall}`);
  out.log(`  cli       v${versions.cli}`);
  out.log(`  node      ${versions.node}`);
  out.log(`  platform  ${versions.platform}`);
  out.log("");
  for (const c of checks) {
    const tag = c.status === "ok" ? "[ok]  " : c.status === "warn" ? "[warn]" : "[err] ";
    out.log(`  ${tag} ${c.name}${c.message ? ` — ${c.message}` : ""}`);
  }
  if (overall === "warn") {
    out.log("");
    out.log("  warn-level checks are safe to ignore for dry-run usage. Set the relevant");
    out.log("  variables before re-running without --dry-run.");
  }
  return overall === "error" ? 1 : 0;
}
