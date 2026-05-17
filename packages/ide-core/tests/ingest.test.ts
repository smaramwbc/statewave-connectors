import { describe, it, expect } from "vitest";
import {
  createIngestClient,
  ingestEpisodes,
  fileChangedEpisode,
  type StatewaveEpisode,
} from "../src/index.js";

function sampleEpisode(): StatewaveEpisode {
  return fileChangedEpisode({
    subject: "repo:acme/widgets",
    redactionEnabled: false,
    occurredAt: "2026-01-01T00:00:00.000Z",
    change: {
      relativePath: "src/a.ts",
      absolutePath: "/abs/src/a.ts",
      changeType: "saved",
      hash: "h1",
    },
  });
}

describe("ingestEpisodes", () => {
  it("dry-run never touches the network", async () => {
    const out = await ingestEpisodes([sampleEpisode(), sampleEpisode()], {
      dryRun: true,
    });
    expect(out.dryRun).toBe(true);
    expect(out.attempted).toBe(2);
    expect(out.ingested).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.kinds["ide.file.changed"]).toBe(2);
  });

  it("non-dry-run requires a client", async () => {
    await expect(
      ingestEpisodes([sampleEpisode()], { dryRun: false }),
    ).rejects.toThrow(/without a configured client/);
  });

  it("ingests via the injected client and counts failures", async () => {
    let calls = 0;
    const fakeClient = {
      async ingestEpisode() {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        return { idempotency_key: "k", duplicate: false };
      },
    } as unknown as Parameters<typeof ingestEpisodes>[1]["client"];

    const out = await ingestEpisodes(
      [sampleEpisode(), sampleEpisode(), sampleEpisode()],
      { dryRun: false, client: fakeClient },
    );
    expect(out.attempted).toBe(3);
    expect(out.ingested).toBe(2);
    expect(out.failed).toBe(1);
    expect(out.errorSample).toBe("boom");
  });
});

describe("createIngestClient", () => {
  it("refuses to build a client without a URL", () => {
    expect(() => createIngestClient({})).toThrow(/URL is not configured/);
  });

  it("builds a StatewaveClient when configured", () => {
    const client = createIngestClient({ url: "http://localhost:8000", apiKey: "k" });
    expect(client).toBeTruthy();
    expect(typeof client.ingestEpisode).toBe("function");
  });
});
