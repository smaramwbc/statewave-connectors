import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { StatewaveClient } from "../src/index.js";
import { DEFAULT_SERVER_VERSION, handleJsonRpcMessage } from "../src/protocol.js";
import { SERVER_VERSION } from "../src/version.js";

const packageVersion = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

// `initialize` never reaches the network, so an unused client is enough here.
const client = new StatewaveClient({ url: "http://localhost:8000" });

describe("reported version", () => {
  it("matches the package version", () => {
    expect(SERVER_VERSION).toBe(packageVersion);
    expect(DEFAULT_SERVER_VERSION).toBe(packageVersion);
  });

  it("is what the MCP initialize handshake reports to clients", async () => {
    // The stale constant this guards against shipped for several releases:
    // clients negotiating a session saw 0.1.0 while the package was at 0.4.8.
    const res = await handleJsonRpcMessage(client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    const serverInfo = (res?.result as { serverInfo?: { version?: string } } | undefined)
      ?.serverInfo;

    expect(serverInfo?.version).toBe(packageVersion);
  });
});
