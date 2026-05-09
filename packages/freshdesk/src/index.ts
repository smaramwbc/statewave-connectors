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
