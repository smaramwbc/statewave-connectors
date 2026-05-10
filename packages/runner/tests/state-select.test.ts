import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectPullCursorStore } from "../src/state/select.js";
import { isClosable } from "../src/state/types.js";

describe("selectPullCursorStore", () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const d of created.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("returns the in-memory store when [runner.state] is omitted", async () => {
    const store = await selectPullCursorStore({ runner: {} });
    expect(isClosable(store)).toBe(false);
    await store.set("github", "main", "x");
    expect(await store.get("github", "main")).toBe("x");
  });

  it("returns the in-memory store when kind=memory", async () => {
    const store = await selectPullCursorStore({
      runner: { state: { kind: "memory" } },
    });
    expect(isClosable(store)).toBe(false);
  });

  it("returns the file store when kind=file (explicit path)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "swc-select-"));
    created.push(dir);
    const file = path.join(dir, "cursors.json");
    const store = await selectPullCursorStore({
      runner: { state: { kind: "file", path: file } },
    });
    expect(isClosable(store)).toBe(true);
    await store.set("github", "main", "from-file");
    expect(await store.get("github", "main")).toBe("from-file");
    if (isClosable(store)) await store.close();
  });

  it("falls back to <state_dir>/cursors.json when kind=file and path is omitted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "swc-select-"));
    created.push(dir);
    const store = await selectPullCursorStore({
      runner: { state_dir: dir, state: { kind: "file" } },
    });
    expect(isClosable(store)).toBe(true);
    if (isClosable(store)) await store.close();
  });
});
