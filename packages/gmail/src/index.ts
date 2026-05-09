export { createGmailConnector } from "./sync.js";
export type { GmailConnectorConfig } from "./sync.js";
export { GmailClient } from "./client.js";
export type { GmailClientOptions } from "./client.js";
export { classifyMessage, defaultSubject, mapGmailEvent } from "./mapper.js";
export type {
  GmailEvent,
  GmailEventKind,
  GmailMessage,
  GmailOAuthCredentials,
} from "./types.js";
