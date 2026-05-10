export { createZendeskConnector } from "./sync.js";
export type { ZendeskConnectorConfig } from "./sync.js";
export { ZendeskClient } from "./client.js";
export type { ZendeskClientOptions } from "./client.js";
export { defaultSubject, mapZendeskEvent } from "./mapper.js";
export type {
  ZendeskAuth,
  ZendeskComment,
  ZendeskEvent,
  ZendeskEventKind,
  ZendeskOrganization,
  ZendeskTicket,
  ZendeskTicketStatus,
  ZendeskUser,
} from "./types.js";
export { createZendeskWebhookHandler } from "./webhook.js";
export type {
  StatewaveIngest,
  ZendeskWebhookConfig,
  ZendeskWebhookHandler,
} from "./webhook.js";
export {
  InMemoryZendeskDedupCache,
} from "./webhook-dedup.js";
export type {
  InMemoryZendeskDedupCacheOptions,
  ZendeskDedupCache,
} from "./webhook-dedup.js";
export type {
  ZendeskEventWebhookPayload,
  ZendeskTriggerEvent,
  ZendeskTriggerWebhookPayload,
  ZendeskWebhookComment,
  ZendeskWebhookTicket,
} from "./webhook-types.js";
