// The meta-package re-exports every shipped connector's public factory
// (and the connectors-core types). The test catches any future regression
// where a re-export gets accidentally dropped — without it, "@statewavedev/connectors"
// could silently lose a connector and CI would still pass because individual
// package tests don't exercise this surface.
import { describe, it, expect } from "vitest";
import * as meta from "../src/index.js";

describe("@statewavedev/connectors meta-package", () => {
  it("re-exports every Phase-1 + Phase-2 factory", () => {
    expect(typeof meta.createGithubConnector).toBe("function");
    expect(typeof meta.createMarkdownConnector).toBe("function");
    expect(typeof meta.createSlackConnector).toBe("function");
    expect(typeof meta.createN8nConnector).toBe("function");
    expect(typeof meta.formatZapToEpisode).toBe("function");
    expect(typeof meta.createDiscordConnector).toBe("function");
    expect(typeof meta.createZendeskConnector).toBe("function");
    expect(typeof meta.createIntercomConnector).toBe("function");
  });

  it("re-exports core types and helpers via the wildcard", () => {
    // ConnectorError is one of the most-used core exports; if `* from core`
    // breaks, this catches it. EpisodeBuilder is the other anchor.
    expect(typeof meta.ConnectorError).toBe("function");
    expect(typeof meta.EpisodeBuilder).toBe("function");
    expect(typeof meta.summarizeEpisodes).toBe("function");
  });
});
