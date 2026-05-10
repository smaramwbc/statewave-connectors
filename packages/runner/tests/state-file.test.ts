import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openFileBackedPullCursorStore } from "../src/state/file.js";

describe("openFileBackedPullCursorStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "swc-state-"));
    file = path.join(dir, "cursors.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns undefined for unknown keys (cold start, no file)", async () => {
    const store = await openFileBackedPullCursorStore({ path: file });
    expect(await store.get("github", "main")).toBeUndefined();
    await store.close();
  });

  it("set + get round-trips, persists across re-open", async () => {
    const store1 = await openFileBackedPullCursorStore({ path: file });
    await store1.set("github", "main", "cursor-1");
    await store1.set("gmail", "inbox", "h-100");
    expect(await store1.get("github", "main")).toBe("cursor-1");
    await store1.close();

    // Re-open the same path — values must survive.
    const store2 = await openFileBackedPullCursorStore({ path: file });
    expect(await store2.get("github", "main")).toBe("cursor-1");
    expect(await store2.get("gmail", "inbox")).toBe("h-100");
    await store2.close();
  });

  it("creates the parent directory on first write", async () => {
    const nested = path.join(dir, "deep", "nested", "cursors.json");
    const store = await openFileBackedPullCursorStore({ path: nested });
    await store.set("github", "main", "cursor-1");
    const text = await readFile(nested, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      cursors: { "github/main": "cursor-1" },
    });
    await store.close();
  });

  it("writes are atomic — final file is always valid JSON even under concurrent writes", async () => {
    const store = await openFileBackedPullCursorStore({ path: file });
    // Fire 50 concurrent writes; the queue serializes them. After the
    // last set() resolves, the file MUST contain all 50 keys with
    // their final values.
    const writes = [];
    for (let i = 0; i < 50; i += 1) {
      writes.push(store.set("github", `repo-${i}`, `cursor-${i}`));
    }
    await Promise.all(writes);
    const text = await readFile(file, "utf8");
    const parsed = JSON.parse(text) as { cursors: Record<string, string> };
    expect(Object.keys(parsed.cursors)).toHaveLength(50);
    expect(parsed.cursors["github/repo-25"]).toBe("cursor-25");
    await store.close();
  });

  it("rejects a corrupt JSON file (refuses to overwrite)", async () => {
    await writeFile(file, "{ not valid json", "utf8");
    await expect(openFileBackedPullCursorStore({ path: file })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects an unsupported version (forward-compat sentry)", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 999, cursors: {} }),
      "utf8",
    );
    await expect(openFileBackedPullCursorStore({ path: file })).rejects.toThrow(
      /unsupported version=999/,
    );
  });

  it("rejects a file missing the .cursors map", async () => {
    await writeFile(file, JSON.stringify({ version: 1 }), "utf8");
    await expect(openFileBackedPullCursorStore({ path: file })).rejects.toThrow(
      /missing the \.cursors map/,
    );
  });

  it("close() drains in-flight writes before resolving", async () => {
    const store = await openFileBackedPullCursorStore({ path: file });
    // Don't await — let close() drain the queued write.
    void store.set("github", "main", "drained-cursor");
    await store.close();
    const text = await readFile(file, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      cursors: { "github/main": "drained-cursor" },
    });
  });
});
