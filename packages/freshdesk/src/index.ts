export { createFreshdeskConnector } from "./sync.js";
export type { FreshdeskConnectorConfig } from "./sync.js";
export { FreshdeskClient } from "./client.js";
export type { FreshdeskClientOptions } from "./client.js";
export { defaultSubject, mapFreshdeskEvent } from "./mapper.js";
export {
  FRESHDESK_STATUS_BY_CODE,
  type FreshdeskCompany,
  type FreshdeskConversation,
  type FreshdeskEvent,
  type FreshdeskEventKind,
  type FreshdeskTicket,
  type FreshdeskTicketStatus,
  type FreshdeskUser,
} from "./types.js";
export { createFreshdeskWebhookHandler } from "./webhook.js";
export type {
  FreshdeskWebhookConfig,
  FreshdeskWebhookHandler,
  StatewaveIngest,
} from "./webhook.js";
export {
  InMemoryFreshdeskDedupCache,
  type FreshdeskDedupCache,
  type InMemoryFreshdeskDedupCacheOptions,
} from "./webhook-dedup.js";
export type {
  FreshdeskWebhookComment,
  FreshdeskWebhookEvent,
  FreshdeskWebhookPayload,
  FreshdeskWebhookTicket,
} from "./webhook-types.js";
