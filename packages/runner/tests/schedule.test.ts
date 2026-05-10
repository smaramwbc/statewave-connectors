import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSchedule } from "../src/schedule.js";

describe("makeSchedule — human syntax", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires every N seconds for `every 5s`", async () => {
    const ticks = vi.fn();
    const sch = makeSchedule({ spec: "every 5s", name: "test", onTick: ticks });
    sch.start();
    expect(ticks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveBeenCalledTimes(3);
    sch.stop();
  });

  it("does not fire eagerly on start (no thundering herd on restart)", () => {
    const ticks = vi.fn();
    const sch = makeSchedule({ spec: "every 1m", name: "test", onTick: ticks });
    sch.start();
    expect(ticks).not.toHaveBeenCalled();
    sch.stop();
  });

  it("does not overlap if a tick takes longer than the interval", async () => {
    let resolveSlow: () => void = () => undefined;
    const slowTick = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveSlow = r;
        }),
    );
    const sch = makeSchedule({ spec: "every 1s", name: "test", onTick: slowTick });
    sch.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowTick).toHaveBeenCalledTimes(1);
    // Three more intervals pass; the slow tick is still in flight.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(slowTick).toHaveBeenCalledTimes(1);
    // Resolve and let one more interval pass — now a new tick fires.
    resolveSlow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(slowTick).toHaveBeenCalledTimes(2);
    sch.stop();
  });

  it("logs (and does not crash) when an onTick throws", async () => {
    const logger = vi.fn();
    const sch = makeSchedule({
      spec: "every 1s",
      name: "test",
      onTick: () => {
        throw new Error("boom");
      },
      logger,
    });
    sch.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logger).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("schedule tick threw"),
      expect.objectContaining({ err: expect.stringContaining("boom") }),
    );
    sch.stop();
  });

  it("stop() prevents further ticks", async () => {
    const ticks = vi.fn();
    const sch = makeSchedule({ spec: "every 1s", name: "test", onTick: ticks });
    sch.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ticks).toHaveBeenCalledTimes(2);
    sch.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ticks).toHaveBeenCalledTimes(2);
  });

  it("translates each unit (s/m/h/d) to the right ms", async () => {
    const cases: Array<[string, number]> = [
      ["every 1s", 1_000],
      ["every 1m", 60_000],
      ["every 1h", 3_600_000],
      ["every 1d", 86_400_000],
    ];
    for (const [spec, ms] of cases) {
      const ticks = vi.fn();
      const sch = makeSchedule({ spec, name: spec, onTick: ticks });
      sch.start();
      await vi.advanceTimersByTimeAsync(ms);
      expect(ticks, spec).toHaveBeenCalledTimes(1);
      sch.stop();
    }
  });
});

describe("makeSchedule — cron syntax", () => {
  it("accepts a cron string and returns a Schedule with start/stop (smoke)", () => {
    const sch = makeSchedule({
      spec: "*/5 * * * *",
      name: "every-5min-cron",
      onTick: () => undefined,
    });
    expect(typeof sch.start).toBe("function");
    expect(typeof sch.stop).toBe("function");
    sch.start();
    sch.stop();
  });
});
