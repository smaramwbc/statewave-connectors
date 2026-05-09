export { createSlackConnector } from "./sync.js";
export type { SlackConnectorConfig } from "./sync.js";
export { SlackClient } from "./client.js";
export type { SlackClientOptions } from "./client.js";
export {
  defaultSubject,
  mapSlackEvent,
  mapSlackPinEvent,
  mapSlackReactionEvent,
} from "./mapper.js";
export type { PinMapperOptions, ReactionMapperOptions } from "./mapper.js";
export type {
  SlackChannelRef,
  SlackEvent,
  SlackEventKind,
  SlackMessage,
  SlackUser,
  SlackWorkspace,
} from "./types.js";

// Live-mode (Events-API webhook receiver) — added in v0.2.
export { createSlackWebhookHandler } from "./webhook.js";
export type { SlackWebhookConfig, SlackWebhookHandler } from "./webhook.js";
export { InMemoryDedupCache } from "./webhook-dedup.js";
export type { SlackDedupCache, InMemoryDedupCacheOptions } from "./webhook-dedup.js";
export { verifySlackSignature, computeSignature } from "./webhook-signature.js";
export type { SignatureVerifyInput, SignatureVerifyResult } from "./webhook-signature.js";
export type {
  SlackEventCallback,
  SlackInboundEvent,
  SlackInboundMessage,
  SlackInboundPin,
  SlackInboundReaction,
  SlackUrlVerification,
  SlackWebhookPayload,
} from "./webhook-types.js";
export type { StatewaveIngest } from "./webhook-ingest.js";
