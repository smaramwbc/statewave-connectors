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
    {
      name: "SLACK_BOT_TOKEN",
      status: process.env.SLACK_BOT_TOKEN ? "ok" : "warn",
      message: process.env.SLACK_BOT_TOKEN
        ? "set — Slack connector will use this bot token"
        : "not set — only required to use the Slack connector",
    },
    {
      name: "N8N_API_KEY",
      status: process.env.N8N_API_KEY ? "ok" : "warn",
      message: process.env.N8N_API_KEY
        ? "set — n8n connector will use this API key"
        : "not set — only required to use the n8n connector",
    },
    {
      name: "N8N_INSTANCE_URL",
      status: process.env.N8N_INSTANCE_URL ? "ok" : "warn",
      message: process.env.N8N_INSTANCE_URL
        ? `set — ${process.env.N8N_INSTANCE_URL}`
        : "not set — only required to use the n8n connector (or pass --instance-url)",
    },
    {
      name: "DISCORD_BOT_TOKEN",
      status: process.env.DISCORD_BOT_TOKEN ? "ok" : "warn",
      message: process.env.DISCORD_BOT_TOKEN
        ? "set — Discord connector will use this bot token"
        : "not set — only required to use the Discord connector",
    },
    {
      name: "ZENDESK_SUBDOMAIN",
      status: process.env.ZENDESK_SUBDOMAIN ? "ok" : "warn",
      message: process.env.ZENDESK_SUBDOMAIN
        ? `set — ${process.env.ZENDESK_SUBDOMAIN}.zendesk.com`
        : "not set — only required to use the Zendesk connector (or pass --subdomain)",
    },
    zendeskAuthCheck(),
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

/**
 * Zendesk auth has two modes; the doctor reports whichever the operator
 * has configured (oauth bearer takes precedence) and warns when neither
 * is fully set.
 */
function zendeskAuthCheck(): Check {
  if (process.env.ZENDESK_OAUTH_TOKEN) {
    return {
      name: "ZENDESK_AUTH",
      status: "ok",
      message: "set — oauth mode (ZENDESK_OAUTH_TOKEN)",
    };
  }
  if (process.env.ZENDESK_API_TOKEN && process.env.ZENDESK_EMAIL) {
    return {
      name: "ZENDESK_AUTH",
      status: "ok",
      message: `set — api_token mode (${process.env.ZENDESK_EMAIL})`,
    };
  }
  return {
    name: "ZENDESK_AUTH",
    status: "warn",
    message:
      "not set — only required to use the Zendesk connector (set ZENDESK_OAUTH_TOKEN, or ZENDESK_EMAIL + ZENDESK_API_TOKEN)",
  };
}
