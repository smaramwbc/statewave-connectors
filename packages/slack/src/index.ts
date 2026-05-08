export { createSlackConnector } from "./sync.js";
export type { SlackConnectorConfig } from "./sync.js";
export { SlackClient } from "./client.js";
export type { SlackClientOptions } from "./client.js";
export { defaultSubject, mapSlackEvent } from "./mapper.js";
export type {
  SlackChannelRef,
  SlackEvent,
  SlackEventKind,
  SlackMessage,
  SlackUser,
  SlackWorkspace,
} from "./types.js";
