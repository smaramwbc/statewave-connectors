import { ConnectorError } from "@statewavedev/connectors-core";
import type { StatewaveClient } from "./client.js";

export interface DispatchResult {
  tool: string;
  result: unknown;
}

export async function dispatchTool(
  client: StatewaveClient,
  tool: string,
  rawInput: unknown,
): Promise<DispatchResult> {
  const input = ensureRecord(rawInput, tool);
  switch (tool) {
    case "statewave_ingest_episode": {
      requireString(input, "subject");
      requireString(input, "kind");
      requireString(input, "text");
      requireString(input, "occurred_at");
      requireString(input, "idempotency_key");
      const source = ensureRecord(input["source"], `${tool}.source`);
      requireString(source, "type");
      requireString(source, "id");
      const episode = {
        subject: input["subject"] as string,
        kind: input["kind"] as string,
        text: input["text"] as string,
        occurred_at: input["occurred_at"] as string,
        source: {
          type: source["type"] as string,
          id: source["id"] as string,
          url: typeof source["url"] === "string" ? (source["url"] as string) : undefined,
        },
        metadata: input["metadata"] as Record<string, unknown> | undefined,
        idempotency_key: input["idempotency_key"] as string,
      };
      return { tool, result: await client.ingestEpisode(episode) };
    }
    case "statewave_search_memories": {
      requireString(input, "query");
      requireString(input, "subject");
      return {
        tool,
        result: await client.searchMemories({
          query: input["query"] as string,
          subject: input["subject"] as string,
          limit: typeof input["limit"] === "number" ? (input["limit"] as number) : undefined,
        }),
      };
    }
    case "statewave_get_context": {
      requireString(input, "subject");
      requireString(input, "query");
      return {
        tool,
        result: await client.getContext({
          subject: input["subject"] as string,
          query: input["query"] as string,
          max_tokens:
            typeof input["max_tokens"] === "number" ? (input["max_tokens"] as number) : undefined,
        }),
      };
    }
    case "statewave_get_timeline": {
      requireString(input, "subject");
      return {
        tool,
        result: await client.getTimeline({
          subject: input["subject"] as string,
          since: typeof input["since"] === "string" ? (input["since"] as string) : undefined,
          until: typeof input["until"] === "string" ? (input["until"] as string) : undefined,
          kinds: Array.isArray(input["kinds"])
            ? ((input["kinds"] as unknown[]).filter((k) => typeof k === "string") as string[])
            : undefined,
          limit: typeof input["limit"] === "number" ? (input["limit"] as number) : undefined,
        }),
      };
    }
    case "statewave_list_subjects": {
      return {
        tool,
        result: await client.listSubjects({
          limit: typeof input["limit"] === "number" ? (input["limit"] as number) : undefined,
          offset: typeof input["offset"] === "number" ? (input["offset"] as number) : undefined,
        }),
      };
    }
    case "statewave_compile_subject": {
      requireString(input, "subject");
      return {
        tool,
        result: await client.compileSubject({
          subject: input["subject"] as string,
          force: typeof input["force"] === "boolean" ? (input["force"] as boolean) : false,
        }),
      };
    }
    default:
      throw new ConnectorError(`unknown tool: ${tool}`, {
        code: "unsupported",
        hint: "valid tools: statewave_ingest_episode, statewave_search_memories, statewave_get_context, statewave_get_timeline, statewave_compile_subject, statewave_list_subjects",
      });
  }
}

function ensureRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorError(`expected object for ${where}`, { code: "config_invalid" });
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): void {
  const v = record[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ConnectorError(`missing required string field: ${key}`, { code: "config_invalid" });
  }
}
