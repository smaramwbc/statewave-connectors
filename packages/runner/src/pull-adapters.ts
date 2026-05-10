// Per-connector pull adapters — translate a `[[pull.<kind>]]` config
// entry into a real `StatewaveConnector` instance the scheduler can
// `.sync()`. One factory per connector kind; the dispatch is a switch
// over the kind string.
//
// The shape is intentionally identical across kinds (same input
// param names, same return type) so adding a new connector is a
// mechanical extension: import its factory, add a case to the switch.

import { ConnectorError, type StatewaveConnector } from "@statewavedev/connectors-core";
import type {
  DiscordPullConfig,
  FreshdeskPullConfig,
  GithubPullConfig,
  GmailPullConfig,
  IntercomPullConfig,
  MarkdownPullConfig,
  N8nPullConfig,
  NotionPullConfig,
  PullConnectors,
  SlackPullConfig,
  ZendeskPullConfig,
} from "@statewavedev/connectors-config";

export type PullConnectorKind = keyof PullConnectors;

export interface PullEntry {
  kind: PullConnectorKind;
  /** Type-narrowed via the kind discriminator at the call site. */
  config: PullConnectors[PullConnectorKind] extends ReadonlyArray<infer T> | undefined
    ? T
    : never;
}

/**
 * Instantiate the right connector for a config entry. Throws
 * `ConnectorError` with a typed `code` if the entry is malformed in
 * a way the validator missed (defensive — Wave 1's validator should
 * have caught everything, so this is a belt-and-braces guard).
 */
export async function instantiatePullConnector(
  kind: PullConnectorKind,
  config: unknown,
): Promise<StatewaveConnector> {
  switch (kind) {
    case "github":
      return loadGithub(config as GithubPullConfig);
    case "markdown":
      return loadMarkdown(config as MarkdownPullConfig);
    case "slack":
      return loadSlack(config as SlackPullConfig);
    case "n8n":
      return loadN8n(config as N8nPullConfig);
    case "discord":
      return loadDiscord(config as DiscordPullConfig);
    case "zendesk":
      return loadZendesk(config as ZendeskPullConfig);
    case "intercom":
      return loadIntercom(config as IntercomPullConfig);
    case "freshdesk":
      return loadFreshdesk(config as FreshdeskPullConfig);
    case "notion":
      return loadNotion(config as NotionPullConfig);
    case "gmail":
      return loadGmail(config as GmailPullConfig);
    default: {
      const exhaustive: never = kind;
      throw new ConnectorError(`unknown pull connector kind: ${String(exhaustive)}`, {
        code: "config_invalid",
      });
    }
  }
}

async function loadGithub(c: GithubPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-github");
  return mod.createGithubConnector({
    repo: c.repo,
    ...(c.token ? { token: c.token } : {}),
  });
}

async function loadMarkdown(c: MarkdownPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-markdown");
  return mod.createMarkdownConnector({ root: c.path });
}

async function loadSlack(c: SlackPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-slack");
  return mod.createSlackConnector({
    token: c.bot_token,
    channels: [...c.channels],
    ...(c.include_dms ? { includeDms: true } : {}),
    ...(c.include_mpim ? { includeMpim: true } : {}),
    ...(c.resolve_users ? { resolveUsers: true } : {}),
  });
}

async function loadN8n(c: N8nPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-n8n");
  return mod.createN8nConnector({
    baseUrl: c.instance_url,
    apiKey: c.api_key,
    workflows: c.workflows ? [...c.workflows] : [],
  });
}

async function loadDiscord(c: DiscordPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-discord");
  return mod.createDiscordConnector({
    token: c.bot_token,
    guildId: c.guild,
    channels: [...c.channels],
  });
}

async function loadZendesk(c: ZendeskPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-zendesk");
  // The Wave 1 validator ensures exactly one mode is satisfied.
  if (c.oauth_token) {
    return mod.createZendeskConnector({
      subdomain: c.subdomain,
      auth: { mode: "oauth", accessToken: c.oauth_token },
      ...(c.use_incremental ? { useIncremental: true } : {}),
    });
  }
  if (c.email && c.api_token) {
    return mod.createZendeskConnector({
      subdomain: c.subdomain,
      auth: { mode: "api_token", email: c.email, apiToken: c.api_token },
      ...(c.use_incremental ? { useIncremental: true } : {}),
    });
  }
  throw new ConnectorError(
    "zendesk pull entry missing auth — Wave 1 validator should have caught this",
    { code: "config_invalid", connector: "zendesk" },
  );
}

async function loadIntercom(c: IntercomPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-intercom");
  return mod.createIntercomConnector({
    accessToken: c.access_token,
    ...(c.region ? { region: c.region } : {}),
    ...(c.app_id ? { appId: c.app_id } : {}),
  });
}

async function loadFreshdesk(c: FreshdeskPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-freshdesk");
  return mod.createFreshdeskConnector({
    subdomain: c.subdomain,
    apiKey: c.api_key,
  });
}

async function loadNotion(c: NotionPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-notion");
  return mod.createNotionConnector({
    token: c.token,
    ...(c.databases ? { databases: [...c.databases] } : {}),
  });
}

async function loadGmail(c: GmailPullConfig): Promise<StatewaveConnector> {
  const mod = await import("@statewavedev/connectors-gmail");
  return mod.createGmailConnector({
    credentials: {
      clientId: c.client_id,
      clientSecret: c.client_secret,
      refreshToken: c.refresh_token,
    },
    query: c.query,
    ...(c.label_ids ? { labelIds: [...c.label_ids] } : {}),
  });
}
