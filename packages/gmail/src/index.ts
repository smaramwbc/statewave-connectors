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
export { createGmailPubsubHandler } from "./webhook.js";
export type {
  GmailHistoryReader,
  GmailPubsubHandler,
  GmailPubsubReceiverConfig,
  StatewaveIngest,
} from "./webhook.js";
export {
  InMemoryGmailHistoryCursorStore,
  InMemoryGmailPubsubDedupCache,
} from "./webhook-cursor.js";
export type {
  GmailHistoryCursorStore,
  GmailPubsubDedupCache,
  InMemoryGmailHistoryCursorStoreOptions,
  InMemoryGmailPubsubDedupCacheOptions,
} from "./webhook-cursor.js";
export type {
  GmailWatchPayload,
  PubsubPushEnvelope,
} from "./webhook-types.js";
export {
  createGoogleOidcVerifier,
  GOOGLE_ISSUER,
  GOOGLE_JWKS_URI,
} from "./oidc.js";
export type {
  GmailOidcConfig,
  OidcVerifier,
  OidcVerifyResult,
} from "./oidc.js";
