import { describe, it, expect } from "vitest";
import {
  runIngestQueue,
  CancellationFlag,
  CompileScheduler,
  deriveStatus,
  diffScan,
  emptyCache,
  isCacheFresh,
  explainPath,
  summarizeTransparency,
  diagnose,
  isSecretFile,
  isIgnored,
  type Timers,
  type ScannedWorkspaceFile,
} from "../src/index.js";

const noSleep = (_ms: number): Promise<void> => Promise.resolve();

describe("runIngestQueue", () => {
  it("ingests all with bounded concurrency and reports progress", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let maxInFlight = 0;
    let live = 0;
    const progress: number[] = [];
    const res = await runIngestQueue(
      items,
      async () => {
        live++;
        maxInFlight = Math.max(maxInFlight, live);
        await Promise.resolve();
        live--;
      },
      { concurrency: 4, onProgress: (p) => progress.push(p.done) },
    );
    expect(res.ok).toBe(20);
    expect(res.failed).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(progress[progress.length - 1]).toBe(20);
  });

  it("retries retryable errors with backoff, then gives up gracefully", async () => {
    let calls = 0;
    const res = await runIngestQueue(
      [1],
      async () => {
        calls++;
        throw Object.assign(new Error("net"), { retryable: true });
      },
      { maxAttempts: 3, sleep: noSleep },
    );
    expect(calls).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.errorSample).toBe("net");
  });

  it("does not retry non-retryable errors and isolates failures", async () => {
    let calls = 0;
    const res = await runIngestQueue(
      [1, 2, 3],
      async (n) => {
        calls++;
        if (n === 2) throw Object.assign(new Error("bad"), { retryable: false });
      },
      { maxAttempts: 5, sleep: noSleep },
    );
    expect(res.ok).toBe(2);
    expect(res.failed).toBe(1);
    expect(calls).toBe(3); // no retries for the non-retryable one
  });

  it("honors cancellation", async () => {
    const cancel = new CancellationFlag();
    const res = await runIngestQueue(
      Array.from({ length: 50 }, (_, i) => i),
      async (n) => {
        if (n === 2) cancel.cancel();
      },
      { concurrency: 1 },
      cancel,
    );
    expect(res.cancelled).toBe(true);
    expect(res.ok).toBeLessThan(50);
  });
});

class FakeClock implements Timers {
  private t = 0;
  private q: Array<{ at: number; fn: () => void; h: number }> = [];
  private seq = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const h = ++this.seq;
    this.q.push({ at: this.t + ms, fn, h });
    return h;
  }
  clearTimeout(handle: unknown): void {
    this.q = this.q.filter((e) => e.h !== handle);
  }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    const due = this.q.filter((e) => e.at <= this.t).sort((a, b) => a.at - b.at);
    this.q = this.q.filter((e) => e.at > this.t);
    for (const e of due) {
      e.fn();
      await Promise.resolve();
    }
  }
}

describe("CompileScheduler", () => {
  it("debounces bursts into one compile and reaches ready", async () => {
    const clock = new FakeClock();
    let compiles = 0;
    const states: string[] = [];
    const s = new CompileScheduler({
      compile: async () => {
        compiles++;
      },
      debounceMs: 1000,
      minIntervalMs: 0,
      timers: clock,
      onChange: (snap) => states.push(snap.state),
    });
    s.request("ingest-completed");
    s.request("assistant-wrote");
    s.request("focus");
    expect(s.snapshot().state).toBe("pending");
    await clock.advance(1000);
    await Promise.resolve();
    expect(compiles).toBe(1);
    expect(s.snapshot().state).toBe("ready");
    expect(states).toContain("compiling");
  });

  it("transitions to failed and re-runs if dirtied mid-compile", async () => {
    const clock = new FakeClock();
    let n = 0;
    const s = new CompileScheduler({
      compile: async () => {
        n++;
        if (n === 1) throw new Error("boom");
      },
      debounceMs: 100,
      minIntervalMs: 0,
      timers: clock,
    });
    s.request("manual");
    await clock.advance(100);
    await Promise.resolve();
    expect(s.snapshot().state).toBe("failed");
    expect(s.snapshot().lastError).toBe("boom");
    s.request("focus");
    await clock.advance(100);
    await Promise.resolve();
    expect(n).toBe(2);
    expect(s.snapshot().state).toBe("ready");
  });

  it("cancelPending drops a not-yet-started compile", async () => {
    const clock = new FakeClock();
    let compiles = 0;
    const s = new CompileScheduler({
      compile: async () => {
        compiles++;
      },
      debounceMs: 500,
      timers: clock,
    });
    s.request("idle-interval");
    s.cancelPending();
    await clock.advance(1000);
    expect(compiles).toBe(0);
    expect(s.snapshot().state).toBe("idle");
  });
});

describe("deriveStatus", () => {
  it("prioritises offline > errors > phase > compile > ready", () => {
    expect(deriveStatus({ phase: "idle", online: false, compile: "ready", errors: 0 }).kind).toBe("error");
    expect(deriveStatus({ phase: "idle", online: true, compile: "ready", errors: 2 }).text).toContain("2 error");
    expect(deriveStatus({ phase: "indexing", online: true, compile: "idle", errors: 0 }).text).toContain("indexing");
    expect(deriveStatus({ phase: "idle", online: true, compile: "pending", errors: 0 }).kind).toBe("warning");
    expect(
      deriveStatus({ phase: "idle", online: true, compile: "ready", errors: 0, memories: 142 }).text,
    ).toContain("142 memories");
  });
});

describe("index cache", () => {
  const f = (p: string, h: string): ScannedWorkspaceFile => ({
    relativePath: p,
    absolutePath: `/abs/${p}`,
    hash: h,
    size: 1,
    mtime: "t",
    category: "source",
  });
  it("computes changed/removed/unchanged and a persistable snapshot", () => {
    const first = diffScan(emptyCache(), [f("a.ts", "1"), f("b.ts", "1")]);
    expect(first.changed).toHaveLength(2);
    expect(isCacheFresh(first)).toBe(false);
    const second = diffScan(first.next, [f("a.ts", "1"), f("b.ts", "2"), f("c.ts", "1")]);
    expect(second.unchanged).toBe(1); // a.ts
    expect(second.changed.map((x) => x.relativePath).sort()).toEqual(["b.ts", "c.ts"]);
    const third = diffScan(second.next, [f("a.ts", "1")]);
    expect(third.removed.sort()).toEqual(["b.ts", "c.ts"]);
    const same = diffScan(third.next, [f("a.ts", "1")]);
    expect(isCacheFresh(same)).toBe(true);
  });
  it("treats a version mismatch as a full rebuild", () => {
    const d = diffScan({ version: 999, files: { "a.ts": "1" } }, [f("a.ts", "1")]);
    expect(d.changed).toHaveLength(1);
  });
});

describe("privacy hardening", () => {
  it("never indexes secret files, even via includeGlobs", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile("config/.env.production")).toBe(true);
    expect(isSecretFile("server.pem")).toBe(true);
    expect(isSecretFile("deploy/id_rsa")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("src/index.ts")).toBe(false);
    expect(isIgnored(".env", { includeGlobs: ["**/*"] })).toBe(true);
    expect(isIgnored("src/index.ts", { includeGlobs: ["**/*"] })).toBe(false);
  });
  it("explainPath gives the same verdict + a reason", () => {
    expect(explainPath(".env").indexed).toBe(false);
    expect(explainPath(".env").reason).toMatch(/secret/);
    expect(explainPath("src/a.ts").indexed).toBe(true);
    const r = summarizeTransparency([".env", "src/a.ts", "node_modules/x.js"]);
    expect(r.indexed.map((e) => e.path)).toEqual(["src/a.ts"]);
    expect(r.skipped).toHaveLength(2);
  });
});

describe("diagnose", () => {
  it("flags unreachable server with a fix and marks not-ok", () => {
    const r = diagnose({
      serverUrl: "http://localhost:8100",
      serverReachable: false,
      subject: "repo:a.b",
      subjectStrategy: "auto",
      mcpProviderRegistered: true,
      mcpClientsWired: [],
      instructionClients: ["copilot"],
      watcherActive: false,
      autoIndex: false,
      redactionEnabled: true,
      lastCompile: "ready",
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.severity === "error" && /unreachable/.test(f.message))).toBe(true);
    expect(r.text).toContain("ACTION NEEDED");
  });
  it("is ok when everything checks out", () => {
    const r = diagnose({
      serverUrl: "http://localhost:8100",
      serverReachable: true,
      authValid: true,
      subject: "repo:a.b",
      subjectStrategy: "auto",
      mcpProviderRegistered: true,
      mcpClientsWired: ["cursor"],
      instructionClients: ["copilot"],
      watcherActive: true,
      autoIndex: false,
      redactionEnabled: true,
      lastCompile: "ready",
      lastBuildAt: Date.now(),
      indexedCount: 100,
      skippedCount: 20,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("OK");
  });
});
