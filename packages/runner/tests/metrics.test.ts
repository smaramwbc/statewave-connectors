import { describe, it, expect, vi } from "vitest";
import { createRunner } from "../src/runner.js";
import type { StatewaveConnectorsConfig } from "@statewavedev/connectors-config";

function bareConfig(extra: Partial<StatewaveConnectorsConfig> = {}): StatewaveConnectorsConfig {
  return {
    statewave: { url: "http://localhost:8000" },
    runner: {
      port: 0,
      host: "127.0.0.1",
      log_format: "json",
      ...(extra.runner ?? {}),
    },
    pull: extra.pull ?? {},
    push: extra.push ?? {},
  };
}

async function getText(host: string, port: number, path: string, init?: RequestInit) {
  const res = await fetch(`http://${host}:${port}${path}`, init);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

describe("/metrics endpoint", () => {
  it("exposes prom-format metrics with the expected runner series", async () => {
    const runner = await createRunner({
      config: bareConfig({
        pull: {
          markdown: [
            { name: "docs", schedule: "every 1h", path: "./docs" },
          ],
        },
        push: {
          freshdesk: [{ name: "demo", signing_secret: "x" }],
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true, // makes the assertion list deterministic
      version: "0.3.0",
    });
    await runner.start();
    const { bindAddress } = runner.describe();
    const r = await getText(bindAddress.host, bindAddress.port, "/metrics");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");

    // Prom format: each series is on its own line, prefixed by # HELP / # TYPE.
    expect(r.body).toContain("# HELP statewave_runner_info");
    expect(r.body).toContain("# TYPE statewave_runner_info gauge");
    expect(r.body).toContain('statewave_runner_info{version="0.3.0",hostname=');

    // Receivers-mounted gauge reflects the one push entry above.
    expect(r.body).toMatch(/statewave_runner_push_receivers_mounted\s+1/);
    // Schedules-armed gauge reflects the one pull entry.
    expect(r.body).toMatch(/statewave_runner_schedules_armed\s+1/);
    expect(r.body).toMatch(/statewave_runner_ready\s+1/);

    await runner.stop();
  });

  it("returns 404 when [runner.metrics].path is overridden and the default path is hit", async () => {
    const runner = await createRunner({
      config: bareConfig({
        runner: {
          port: 0,
          host: "127.0.0.1",
          log_format: "json",
          metrics: { path: "/internal/metrics" },
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    const { bindAddress } = runner.describe();
    const defaultPath = await getText(bindAddress.host, bindAddress.port, "/metrics");
    expect(defaultPath.status).toBe(404);
    const customPath = await getText(bindAddress.host, bindAddress.port, "/internal/metrics");
    expect(customPath.status).toBe(200);
    expect(customPath.body).toContain("statewave_runner_info");
    await runner.stop();
  });

  it("/healthz and /readyz remain unauthenticated even when /metrics auth is on", async () => {
    const runner = await createRunner({
      config: bareConfig({
        runner: {
          port: 0,
          host: "127.0.0.1",
          log_format: "json",
          metrics: { auth: { kind: "bearer", token: "secret-token" } },
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    const { bindAddress } = runner.describe();

    // No auth header — health probes still 200.
    const healthz = await getText(bindAddress.host, bindAddress.port, "/healthz");
    expect(healthz.status).toBe(200);
    const readyz = await getText(bindAddress.host, bindAddress.port, "/readyz");
    expect(readyz.status).toBe(200);

    // Metrics rejects.
    const metricsUnauth = await getText(bindAddress.host, bindAddress.port, "/metrics");
    expect(metricsUnauth.status).toBe(401);
    expect(metricsUnauth.headers.get("www-authenticate")).toContain("Bearer");

    await runner.stop();
  });
});

describe("/metrics auth — bearer", () => {
  async function setup(token: string) {
    const runner = await createRunner({
      config: bareConfig({
        runner: {
          port: 0,
          host: "127.0.0.1",
          log_format: "json",
          metrics: { auth: { kind: "bearer", token } },
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    return { runner, addr: runner.describe().bindAddress };
  }

  it("rejects missing Authorization header", async () => {
    const { runner, addr } = await setup("the-token");
    const r = await getText(addr.host, addr.port, "/metrics");
    expect(r.status).toBe(401);
    await runner.stop();
  });

  it("rejects wrong token", async () => {
    const { runner, addr } = await setup("the-token");
    const r = await getText(addr.host, addr.port, "/metrics", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(r.status).toBe(401);
    await runner.stop();
  });

  it("accepts the correct token", async () => {
    const { runner, addr } = await setup("the-token");
    const r = await getText(addr.host, addr.port, "/metrics", {
      headers: { authorization: "Bearer the-token" },
    });
    expect(r.status).toBe(200);
    await runner.stop();
  });
});

describe("/metrics auth — basic", () => {
  it("accepts correct credentials, rejects wrong ones", async () => {
    const runner = await createRunner({
      config: bareConfig({
        runner: {
          port: 0,
          host: "127.0.0.1",
          log_format: "json",
          metrics: { auth: { kind: "basic", username: "ops", password: "swordfish" } },
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    const { bindAddress: addr } = runner.describe();
    const goodAuth = `Basic ${Buffer.from("ops:swordfish", "utf8").toString("base64")}`;
    const badAuth = `Basic ${Buffer.from("ops:wrong", "utf8").toString("base64")}`;

    const ok = await getText(addr.host, addr.port, "/metrics", {
      headers: { authorization: goodAuth },
    });
    expect(ok.status).toBe(200);

    const fail = await getText(addr.host, addr.port, "/metrics", {
      headers: { authorization: badAuth },
    });
    expect(fail.status).toBe(401);

    await runner.stop();
  });
});

describe("push receiver instrumentation", () => {
  it("counts deliveries + responses per (kind, name) and records duration", async () => {
    const runner = await createRunner({
      config: bareConfig({
        push: {
          freshdesk: [{ name: "demo", signing_secret: "x" }],
          slack: [{ name: "team", signing_secret: "x", channels: ["C0"] }],
        },
      }),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    const { bindAddress: addr } = runner.describe();

    // Hit the freshdesk receiver twice (both will return 401 since no
    // signature header) and slack once. Three total deliveries; metrics
    // partitioned per (kind, name).
    await fetch(`http://${addr.host}:${addr.port}/freshdesk/demo/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await fetch(`http://${addr.host}:${addr.port}/freshdesk/demo/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await fetch(`http://${addr.host}:${addr.port}/slack/team/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const m = await getText(addr.host, addr.port, "/metrics");
    expect(m.status).toBe(200);
    expect(m.body).toMatch(
      /statewave_runner_push_deliveries_total\{kind="freshdesk",name="demo"\}\s+2/,
    );
    expect(m.body).toMatch(
      /statewave_runner_push_deliveries_total\{kind="slack",name="team"\}\s+1/,
    );
    expect(m.body).toMatch(
      /statewave_runner_push_responses_total\{kind="freshdesk",name="demo",status="401"\}\s+2/,
    );
    expect(m.body).toContain("statewave_runner_push_delivery_duration_seconds_bucket");

    await runner.stop();
  });
});

describe("ready gauge", () => {
  it("toggles with the runner lifecycle", async () => {
    const runner = await createRunner({
      config: bareConfig(),
      ingest: vi.fn(),
      disableDefaultMetrics: true,
    });
    await runner.start();
    const { bindAddress: addr } = runner.describe();

    const beforeStop = await getText(addr.host, addr.port, "/metrics");
    expect(beforeStop.body).toMatch(/statewave_runner_ready\s+1/);

    await runner.stop();

    // After stop the server is closed; we can't fetch /metrics anymore.
    // The lifecycle test already covered the flip; this one just
    // confirms the up-state value while running. Skipping the
    // post-stop fetch (orchestrator would see ECONNREFUSED).
  });
});
