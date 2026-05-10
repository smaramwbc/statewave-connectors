// Per-receiver push adapters — translate a `[[push.<kind>]]` config
// entry into a real `(Request) => Promise<Response>` handler the
// runner's HTTP server can mount.
//
// Each adapter:
//   - Imports the receiver's factory from its connector package.
//   - Builds the factory config from the parsed config entry.
//   - Injects the runner's shared `ingest` sink so all push traffic
//     flows through the same place pull traffic does.
//   - Returns the handler ready to be mounted at /<kind>/<name>/events.
//
// The receivers each ship their own in-memory dedup cache by default;
// Wave 3 will inject persistent caches via the same factory args.

import type {
  FreshdeskPushConfig,
  GmailPushConfig,
  IntercomPushConfig,
  PushConnectors,
  SlackPushConfig,
  ZendeskPushConfig,
} from "@statewavedev/connectors-config";
import type { StatewaveIngest } from "./ingest.js";
import type { Logger } from "./logger.js";

export type PushReceiverKind = keyof PushConnectors;

export type PushHandler = (req: Request) => Promise<Response>;

export interface InstantiatePushOptions {
  kind: PushReceiverKind;
  name: string;
  config: unknown;
  ingest: StatewaveIngest;
  logger: Logger;
}

export async function instantiatePushHandler(
  options: InstantiatePushOptions,
): Promise<PushHandler> {
  const { kind, name, config, ingest, logger } = options;
  const sourceLogger = logger.withSource(`push:${kind}/${name}`);
  const adapterLogger = (level: "info" | "warn" | "error", msg: string, ctx?: unknown) =>
    sourceLogger[level](msg, ctx as Record<string, unknown> | undefined);

  switch (kind) {
    case "slack":
      return loadSlack(config as SlackPushConfig, ingest, adapterLogger);
    case "freshdesk":
      return loadFreshdesk(config as FreshdeskPushConfig, ingest, adapterLogger);
    case "zendesk":
      return loadZendesk(config as ZendeskPushConfig, ingest, adapterLogger);
    case "intercom":
      return loadIntercom(config as IntercomPushConfig, ingest, adapterLogger);
    case "gmail":
      return loadGmail(config as GmailPushConfig, ingest, adapterLogger);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown push receiver kind: ${String(exhaustive)}`);
    }
  }
}

type AdapterLogger = (
  level: "info" | "warn" | "error",
  msg: string,
  ctx?: unknown,
) => void;

async function loadSlack(
  c: SlackPushConfig,
  ingest: StatewaveIngest,
  logger: AdapterLogger,
): Promise<PushHandler> {
  const mod = await import("@statewavedev/connectors-slack");
  return mod.createSlackWebhookHandler({
    signingSecret: c.signing_secret,
    channels: [...c.channels],
    ingest,
    logger,
    ...(c.accept_dms ? { acceptDms: true } : {}),
    ...(c.accept_mpim ? { acceptMpim: true } : {}),
  });
}

async function loadFreshdesk(
  c: FreshdeskPushConfig,
  ingest: StatewaveIngest,
  logger: AdapterLogger,
): Promise<PushHandler> {
  const mod = await import("@statewavedev/connectors-freshdesk");
  return mod.createFreshdeskWebhookHandler({
    signingSecret: c.signing_secret,
    ingest,
    logger,
    ...(c.signing_header ? { signingHeader: c.signing_header } : {}),
    ...(c.subdomain ? { subdomain: c.subdomain } : {}),
  });
}

async function loadZendesk(
  c: ZendeskPushConfig,
  ingest: StatewaveIngest,
  logger: AdapterLogger,
): Promise<PushHandler> {
  const mod = await import("@statewavedev/connectors-zendesk");
  return mod.createZendeskWebhookHandler({
    signingSecret: c.signing_secret,
    ingest,
    logger,
    ...(c.subdomain ? { subdomain: c.subdomain } : {}),
    ...(c.replay_window_sec !== undefined ? { replayWindowSec: c.replay_window_sec } : {}),
  });
}

async function loadIntercom(
  c: IntercomPushConfig,
  ingest: StatewaveIngest,
  logger: AdapterLogger,
): Promise<PushHandler> {
  const mod = await import("@statewavedev/connectors-intercom");
  return mod.createIntercomWebhookHandler({
    signingSecret: c.signing_secret,
    ingest,
    logger,
    ...(c.app_id ? { appId: c.app_id } : {}),
    ...(c.region ? { region: c.region } : {}),
  });
}

async function loadGmail(
  c: GmailPushConfig,
  ingest: StatewaveIngest,
  logger: AdapterLogger,
): Promise<PushHandler> {
  const mod = await import("@statewavedev/connectors-gmail");
  return mod.createGmailPubsubHandler({
    pathToken: c.path_token,
    credentials: {
      clientId: c.client_id,
      clientSecret: c.client_secret,
      refreshToken: c.refresh_token,
    },
    ingest,
    logger,
    ...(c.query ? { query: c.query } : {}),
    ...(c.label_ids ? { labelIds: [...c.label_ids] } : {}),
    ...(c.max_items !== undefined ? { maxItems: c.max_items } : {}),
  });
}
