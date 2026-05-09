import type { ParsedArgs } from "../args.js";
import { flagAsBool, flagAsString } from "../args.js";
import { Output } from "../output.js";

const KNOWN = new Set(["github", "markdown", "slack", "n8n", "zapier", "discord", "mcp"]);

export async function runTest(args: ParsedArgs): Promise<number> {
  const out = new Output({ json: flagAsBool(args, "json") });
  const name = flagAsString(args, "connector");

  if (!name) {
    out.error("--connector is required", "example: --connector github");
    return 2;
  }
  if (!KNOWN.has(name)) {
    out.error(`unknown connector: ${name}`, `supported: ${[...KNOWN].join(", ")}`);
    return 2;
  }

  const result = {
    connector: name,
    status: "ok",
    note: "lightweight wiring test — confirms the connector module loads and exposes the expected factory",
  };

  try {
    if (name === "github") {
      const mod = await import("@statewavedev/connectors-github");
      if (typeof mod.createGithubConnector !== "function") throw new Error("createGithubConnector missing");
    } else if (name === "markdown") {
      const mod = await import("@statewavedev/connectors-markdown");
      if (typeof mod.createMarkdownConnector !== "function") throw new Error("createMarkdownConnector missing");
    } else if (name === "slack") {
      const mod = await import("@statewavedev/connectors-slack");
      if (typeof mod.createSlackConnector !== "function") throw new Error("createSlackConnector missing");
    } else if (name === "n8n") {
      const mod = await import("@statewavedev/connectors-n8n");
      if (typeof mod.createN8nConnector !== "function") throw new Error("createN8nConnector missing");
    } else if (name === "zapier") {
      const mod = await import("@statewavedev/connectors-zapier");
      if (typeof mod.formatZapToEpisode !== "function") throw new Error("formatZapToEpisode missing");
    } else if (name === "discord") {
      const mod = await import("@statewavedev/connectors-discord");
      if (typeof mod.createDiscordConnector !== "function") throw new Error("createDiscordConnector missing");
    }
  } catch (err) {
    out.error(`connector ${name} failed to load: ${(err as Error).message}`);
    return 1;
  }

  if (out.isJson()) out.data(result);
  else out.log(`connector ${name}: ok`);
  return 0;
}
