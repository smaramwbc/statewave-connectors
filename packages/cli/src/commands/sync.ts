import { ConnectorError, type StatewaveConnector, type SyncOptions } from "@statewavedev/connectors-core";
import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsInt, flagAsList, flagAsString } from "../args.js";
import { readStatewaveEnv } from "../env.js";
import { Output } from "../output.js";

export async function runSync(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const [, source] = args.positional;

  if (!source) {
    out.error("missing connector name", "usage: statewave-connectors sync <connector> [options]");
    return 2;
  }

  const dryRun = flagAsBool(args, "dry-run");
  const syncOptions: SyncOptions = {
    subject: flagAsString(args, "subject"),
    since: flagAsString(args, "since"),
    maxItems: flagAsInt(args, "max-items"),
    dryRun,
    include: flagAsList(args, "include"),
    exclude: flagAsList(args, "exclude"),
    cursor: flagAsString(args, "cursor"),
    json: out.isJson(),
    redaction: parseRedaction(args),
  };

  let connector: StatewaveConnector;
  try {
    connector = await loadConnector(source, args);
  } catch (err) {
    return reportError(out, err);
  }

  if (!dryRun) {
    const env = readStatewaveEnv();
    if (!env.url) {
      out.error(
        "STATEWAVE_URL is not set; refusing to ingest",
        "set STATEWAVE_URL or pass --dry-run to preview mapped episodes",
      );
      return 1;
    }
  }

  try {
    const result = await connector.sync(syncOptions);
    if (out.isJson()) {
      // Stable JSON shape: connector, source, subject, dryRun, summary, episodes,
      // plus the timing/cursor/ingested/skipped fields downstream tools may want.
      out.data({
        connector: result.connector,
        source: result.source,
        subject: result.subject,
        dryRun: result.dryRun,
        summary: result.summary,
        ingested: result.ingested,
        skipped: result.skipped,
        cursor: result.cursor,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        episodes: result.episodes,
      });
    } else {
      out.log(
        `synced ${result.connector} (${result.source})${result.subject ? ` subject=${result.subject}` : ""}`,
      );
      out.log(
        `  episodes=${result.episodes.length} ingested=${result.ingested} skipped=${result.skipped} dryRun=${result.dryRun}`,
      );
      const kinds = result.summary.kinds;
      const kindEntries = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
      if (kindEntries.length > 0) {
        out.log("  kinds:");
        for (const [k, n] of kindEntries) out.log(`    ${k.padEnd(28)} ${n}`);
      }
      if (result.summary.details) {
        const details = Object.entries(result.summary.details).filter(([, v]) => v > 0);
        if (details.length > 0) {
          out.log("  details:");
          for (const [k, v] of details) out.log(`    ${k.padEnd(28)} ${v}`);
        }
      }
      if (dryRun) {
        const SAMPLE = 20;
        if (result.episodes.length > 0) {
          out.log(`  sample episodes (first ${Math.min(SAMPLE, result.episodes.length)}):`);
          for (const ep of result.episodes.slice(0, SAMPLE)) {
            out.log(`    - ${ep.kind} ${ep.source.id} subject=${ep.subject}`);
          }
          if (result.episodes.length > SAMPLE) {
            out.log(`    …and ${result.episodes.length - SAMPLE} more`);
          }
        }
        out.log("");
        out.log("  dry-run: nothing was ingested. Re-run without --dry-run to send these");
        out.log("  episodes to the Statewave instance at $STATEWAVE_URL.");
      }
    }
    return 0;
  } catch (err) {
    return reportError(out, err);
  }
}

function parseRedaction(args: ParsedArgs): SyncOptions["redaction"] {
  const email = flagAsBool(args, "redact-email");
  const phone = flagAsBool(args, "redact-phone");
  const secrets = flagAsBool(args, "redact-secrets");
  if (!email && !phone && !secrets) return undefined;
  return { email, phone, secrets };
}

async function loadConnector(source: string, args: ParsedArgs): Promise<StatewaveConnector> {
  switch (source) {
    case "github": {
      const mod = await import("@statewavedev/connectors-github");
      const repo = flagAsString(args, "repo");
      if (!repo) {
        throw new ConnectorError("--repo is required for github sync (owner/name)", {
          code: "config_invalid",
          connector: "github",
        });
      }
      return mod.createGithubConnector({ repo, token: process.env.GITHUB_TOKEN });
    }
    case "markdown": {
      const mod = await import("@statewavedev/connectors-markdown");
      const root = flagAsString(args, "path");
      if (!root) {
        throw new ConnectorError("--path is required for markdown sync", {
          code: "config_invalid",
          connector: "markdown",
        });
      }
      return mod.createMarkdownConnector({ root });
    }
    case "slack": {
      const mod = await import("@statewavedev/connectors-slack");
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) {
        throw new ConnectorError("SLACK_BOT_TOKEN is required for slack sync", {
          code: "auth_missing",
          connector: "slack",
          hint: "create a Slack app, add a bot user with channels:history + channels:read scopes, and export SLACK_BOT_TOKEN=xoxb-…",
        });
      }
      const channels = flagAsList(args, "channels") ?? [];
      const includeDms = flagAsBool(args, "include-dms");
      if (channels.length === 0 && !includeDms) {
        throw new ConnectorError(
          "--channels or --include-dms is required for slack sync",
          {
            code: "config_invalid",
            connector: "slack",
            hint: "ingesting an entire workspace by default would be expensive and surprising",
          },
        );
      }
      return mod.createSlackConnector({
        token,
        channels,
        includeDms,
        resolveUsers: flagAsBool(args, "resolve-users"),
      });
    }
    case "n8n": {
      const mod = await import("@statewavedev/connectors-n8n");
      const apiKey = process.env.N8N_API_KEY;
      const baseUrl = flagAsString(args, "instance-url") ?? process.env.N8N_INSTANCE_URL;
      if (!apiKey) {
        throw new ConnectorError("N8N_API_KEY is required for n8n sync", {
          code: "auth_missing",
          connector: "n8n",
          hint: "create an API key in n8n: Settings → API → Create new API key, then export N8N_API_KEY=…",
        });
      }
      if (!baseUrl) {
        throw new ConnectorError(
          "n8n instance URL is required — pass --instance-url or set N8N_INSTANCE_URL",
          {
            code: "config_invalid",
            connector: "n8n",
            hint: "e.g. --instance-url https://n8n.example.com",
          },
        );
      }
      const workflows = flagAsList(args, "workflows");
      if (!workflows || workflows.length === 0) {
        throw new ConnectorError("--workflows is required for n8n sync (comma-separated ids or names)", {
          code: "config_invalid",
          connector: "n8n",
        });
      }
      return mod.createN8nConnector({ baseUrl, apiKey, workflows });
    }
    case "discord": {
      const mod = await import("@statewavedev/connectors-discord");
      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) {
        throw new ConnectorError("DISCORD_BOT_TOKEN is required for discord sync", {
          code: "auth_missing",
          connector: "discord",
          hint:
            "create a Discord bot at https://discord.com/developers/applications, copy the Bot token, " +
            "invite the bot to the target guild with View Channel + Read Message History, then export DISCORD_BOT_TOKEN=…",
        });
      }
      const guildId = flagAsString(args, "guild");
      if (!guildId) {
        throw new ConnectorError(
          "--guild is required for discord sync (server id; enable Developer Mode → right-click server → Copy Server ID)",
          { code: "config_invalid", connector: "discord" },
        );
      }
      const channels = flagAsList(args, "channels");
      if (!channels || channels.length === 0) {
        throw new ConnectorError(
          "--channels is required for discord sync (comma-separated channel ids or names)",
          { code: "config_invalid", connector: "discord" },
        );
      }
      return mod.createDiscordConnector({ token, guildId, channels });
    }
    case "zendesk": {
      const mod = await import("@statewavedev/connectors-zendesk");
      const subdomain = flagAsString(args, "subdomain") ?? process.env.ZENDESK_SUBDOMAIN;
      if (!subdomain) {
        throw new ConnectorError(
          "zendesk subdomain is required — pass --subdomain <acme> or set ZENDESK_SUBDOMAIN",
          {
            code: "config_invalid",
            connector: "zendesk",
            hint: "for `https://acme.zendesk.com`, the subdomain is `acme`",
          },
        );
      }
      // Auth detection: OAuth bearer if ZENDESK_OAUTH_TOKEN / --oauth-token is
      // set; otherwise email + API token (the most common Zendesk path).
      const oauthToken = flagAsString(args, "oauth-token") ?? process.env.ZENDESK_OAUTH_TOKEN;
      const apiToken = flagAsString(args, "api-token") ?? process.env.ZENDESK_API_TOKEN;
      const email = flagAsString(args, "email") ?? process.env.ZENDESK_EMAIL;
      let auth: import("@statewavedev/connectors-zendesk").ZendeskAuth;
      if (oauthToken) {
        auth = { mode: "oauth", accessToken: oauthToken };
      } else if (apiToken && email) {
        auth = { mode: "api_token", email, apiToken };
      } else {
        throw new ConnectorError(
          "zendesk auth is required — pass --oauth-token, or --email + --api-token",
          {
            code: "auth_missing",
            connector: "zendesk",
            hint:
              "set ZENDESK_OAUTH_TOKEN (oauth mode), or ZENDESK_EMAIL + ZENDESK_API_TOKEN (api token mode)",
          },
        );
      }
      return mod.createZendeskConnector({ subdomain, auth });
    }
    case "intercom": {
      const mod = await import("@statewavedev/connectors-intercom");
      const accessToken =
        flagAsString(args, "access-token") ?? process.env.INTERCOM_ACCESS_TOKEN;
      if (!accessToken) {
        throw new ConnectorError(
          "intercom access token is required — pass --access-token or set INTERCOM_ACCESS_TOKEN",
          {
            code: "auth_missing",
            connector: "intercom",
            hint:
              "create a personal access token at Settings → Workspace settings → Developers → Your apps; or pass an OAuth access token from a public app",
          },
        );
      }
      const regionFlag = flagAsString(args, "region") ?? process.env.INTERCOM_REGION;
      if (regionFlag && !["us", "eu", "au"].includes(regionFlag)) {
        throw new ConnectorError(
          `intercom: unsupported region "${regionFlag}" — use one of: us, eu, au`,
          { code: "config_invalid", connector: "intercom" },
        );
      }
      const region = (regionFlag as import("@statewavedev/connectors-intercom").IntercomRegion | undefined) ?? "us";
      const appId = flagAsString(args, "app-id") ?? process.env.INTERCOM_APP_ID;
      return mod.createIntercomConnector({ accessToken, region, appId });
    }
    default:
      throw new ConnectorError(`unknown connector: ${source}`, {
        code: "unsupported",
        hint: "supported: github, markdown, slack, n8n, discord, zendesk, intercom",
      });
  }
}

function reportError(out: Output, err: unknown): number {
  if (err instanceof ConnectorError) {
    out.error(err.message, err.hint);
    return err.code === "config_invalid" ? 2 : 1;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      out.error(
        `not found: ${err.message}`,
        "check the --path argument; the markdown connector needs an existing directory",
      );
      return 2;
    }
    out.error(err.message);
    return 1;
  }
  out.error(String(err));
  return 1;
}
