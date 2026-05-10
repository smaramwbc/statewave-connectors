import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/parse.js";
import { ConfigError } from "../src/errors.js";

const VALID_CONFIG = `
[statewave]
url     = "\${STATEWAVE_URL}"
api_key = "\${STATEWAVE_API_KEY}"

[runner]
port      = 3000
host      = "0.0.0.0"
state_dir = "./var/connectors-state"

[[pull.github]]
name          = "main-repo"
schedule      = "every 1h"
repo          = "smaramwbc/statewave"
subject       = "repo:smaramwbc/statewave"
token         = "\${GITHUB_TOKEN}"
since_default = "30d"

[[pull.github]]
name     = "second-repo"
schedule = "0 */6 * * *"
repo     = "smaramwbc/statewave-connectors"
token    = "\${GITHUB_TOKEN}"

[[pull.gmail]]
name          = "founder-inbox"
schedule      = "every 15m"
client_id     = "\${GMAIL_CLIENT_ID}"
client_secret = "\${GMAIL_CLIENT_SECRET}"
refresh_token = "\${GMAIL_REFRESH_TOKEN}"
query         = "label:inbox"

[[push.slack]]
name           = "team-events"
signing_secret = "\${SLACK_SIGNING_SECRET}"
channels       = ["C0123ABC"]

[[push.gmail]]
name          = "founder-pubsub"
path_token    = "\${GMAIL_PUBSUB_TOKEN}"
client_id     = "\${GMAIL_CLIENT_ID}"
client_secret = "\${GMAIL_CLIENT_SECRET}"
refresh_token = "\${GMAIL_REFRESH_TOKEN}"
query         = "label:inbox"
`;

const ENV = {
  STATEWAVE_URL: "https://api.example.com",
  STATEWAVE_API_KEY: "key-123",
  GITHUB_TOKEN: "ghp_abc",
  GMAIL_CLIENT_ID: "g-id",
  GMAIL_CLIENT_SECRET: "g-secret",
  GMAIL_REFRESH_TOKEN: "g-refresh",
  SLACK_SIGNING_SECRET: "shh",
  GMAIL_PUBSUB_TOKEN: "tok",
};

describe("loadConfig — valid configs", () => {
  it("loads a multi-instance pull + push config end to end", async () => {
    const loaded = await loadConfig({ rawTomlString: VALID_CONFIG, env: ENV });
    expect(loaded.config.statewave.url).toBe("https://api.example.com");
    expect(loaded.config.statewave.api_key).toBe("key-123");
    expect(loaded.config.runner.port).toBe(3000);
    expect(loaded.config.pull.github).toHaveLength(2);
    expect(loaded.config.pull.github![0].name).toBe("main-repo");
    expect(loaded.config.pull.github![0].repo).toBe("smaramwbc/statewave");
    expect(loaded.config.pull.github![1].name).toBe("second-repo");
    expect(loaded.config.pull.gmail).toHaveLength(1);
    expect(loaded.config.push.slack).toHaveLength(1);
    expect(loaded.config.push.gmail).toHaveLength(1);
  });

  it("interpolates env-var references in nested fields", async () => {
    const loaded = await loadConfig({ rawTomlString: VALID_CONFIG, env: ENV });
    expect(loaded.config.pull.github![0].token).toBe("ghp_abc");
    expect(loaded.config.push.slack![0].signing_secret).toBe("shh");
  });

  it("accepts both `every <N><unit>` and 5-field cron schedules", async () => {
    const loaded = await loadConfig({ rawTomlString: VALID_CONFIG, env: ENV });
    expect(loaded.config.pull.github![0].schedule).toBe("every 1h");
    expect(loaded.config.pull.github![1].schedule).toBe("0 */6 * * *");
  });

  it("a minimal config (no runner block) is valid", async () => {
    const minimal = `
[statewave]
url = "http://localhost:8000"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: minimal, env: {} });
    expect(loaded.config.runner).toEqual({});
    expect(loaded.config.pull.markdown).toHaveLength(1);
  });
});

describe("loadConfig — failure modes", () => {
  it("throws missing_env with the full list of missing vars", async () => {
    await expect(
      loadConfig({ rawTomlString: VALID_CONFIG, env: {} }),
    ).rejects.toMatchObject({
      code: "missing_env",
      missing: expect.arrayContaining([
        "STATEWAVE_URL",
        "STATEWAVE_API_KEY",
        "GITHUB_TOKEN",
        "GMAIL_CLIENT_ID",
      ]),
    });
  });

  it("throws parse_error on TOML syntax errors", async () => {
    await expect(
      loadConfig({ rawTomlString: "[statewave\nurl = ", env: {} }),
    ).rejects.toMatchObject({ code: "parse_error" });
  });

  it("throws validation_error and reports every issue in one pass", async () => {
    const broken = `
[statewave]
# url missing

[[pull.github]]
# name + schedule + repo all missing
token = "x"

[[pull.gmail]]
name     = "Bad Name"
schedule = "every 1q"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
# query missing

[[push.zendesk]]
name           = "z"
signing_secret = "x"
replay_window_sec = -1
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: broken, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    const paths = err?.issues.map((i) => i.path);
    expect(paths).toContain("statewave.url");
    expect(paths).toContain("pull.github[0].name");
    expect(paths).toContain("pull.github[0].schedule");
    expect(paths).toContain("pull.github[0].repo");
    expect(paths).toContain("pull.gmail[0].name");
    expect(paths).toContain("pull.gmail[0].schedule");
    expect(paths).toContain("pull.gmail[0].query");
    expect(paths).toContain("push.zendesk[0].replay_window_sec");
  });

  it("rejects duplicate names within the same connector kind", async () => {
    const dupes = `
[statewave]
url = "http://localhost"

[[pull.github]]
name     = "shared"
schedule = "every 1h"
repo     = "a/b"

[[pull.github]]
name     = "shared"
schedule = "every 1h"
repo     = "c/d"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: dupes, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.message.includes("duplicate name"))).toBe(true);
  });

  it("allows the same name across different connector kinds (no collision)", async () => {
    const cross = `
[statewave]
url = "http://localhost"

[[pull.github]]
name     = "primary"
schedule = "every 1h"
repo     = "a/b"

[[pull.markdown]]
name     = "primary"
schedule = "every 1h"
path     = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cross, env: {} });
    expect(loaded.config.pull.github![0].name).toBe("primary");
    expect(loaded.config.pull.markdown![0].name).toBe("primary");
  });

  it("loads [runner.state] kind=memory (or omitted) without state", async () => {
    const memOmit = `
[statewave]
url = "http://localhost"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    const memExplicit = `
[statewave]
url = "http://localhost"

[runner.state]
kind = "memory"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    const omit = await loadConfig({ rawTomlString: memOmit, env: {} });
    expect(omit.config.runner.state).toBeUndefined();
    const explicit = await loadConfig({ rawTomlString: memExplicit, env: {} });
    expect(explicit.config.runner.state).toEqual({ kind: "memory" });
  });

  it("loads [runner.state] kind=file with optional path", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.state]
kind = "file"
path = "/var/lib/sw/cursors.json"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.runner.state).toEqual({
      kind: "file",
      path: "/var/lib/sw/cursors.json",
    });
  });

  it("loads [runner.state] kind=postgres with required url + optional table", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.state]
kind  = "postgres"
url   = "postgres://user:pass@localhost/sw"
table = "my_cursors"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.runner.state).toEqual({
      kind: "postgres",
      url: "postgres://user:pass@localhost/sw",
      table: "my_cursors",
    });
  });

  it("rejects [runner.state] kind=postgres without url", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.state]
kind = "postgres"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.path === "runner.state.url")).toBe(true);
  });

  it("rejects [runner.state] with unknown kind", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.state]
kind = "sqlite"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.message.includes("unknown state kind"))).toBe(true);
  });

  it("rejects [runner.state] kind=postgres with non-identifier table name", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.state]
kind  = "postgres"
url   = "postgres://localhost"
table = "foo; DROP TABLE x"

[[pull.markdown]]
name = "docs"
schedule = "every 5m"
path = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.path === "runner.state.table")).toBe(true);
  });

  it("loads [runner.metrics] with kind=none (default behaviour explicit)", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics]
path = "/internal/metrics"
auth = { kind = "none" }

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.runner.metrics).toEqual({
      path: "/internal/metrics",
      auth: { kind: "none" },
    });
  });

  it("loads [runner.metrics].auth kind=basic", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics.auth]
kind     = "basic"
username = "ops"
password = "shh"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.runner.metrics?.auth).toEqual({
      kind: "basic",
      username: "ops",
      password: "shh",
    });
  });

  it("loads [runner.metrics].auth kind=bearer", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics.auth]
kind  = "bearer"
token = "tok"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.runner.metrics?.auth).toEqual({
      kind: "bearer",
      token: "tok",
    });
  });

  it("rejects [runner.metrics].path without leading slash", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics]
path = "internal/metrics"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.path === "runner.metrics.path")).toBe(true);
  });

  it("rejects [runner.metrics.auth] kind=basic without username/password", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics.auth]
kind = "basic"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.path === "runner.metrics.auth.username")).toBe(true);
    expect(err?.issues.some((i) => i.path === "runner.metrics.auth.password")).toBe(true);
  });

  it("rejects [runner.metrics.auth] kind=bearer without token", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics.auth]
kind = "bearer"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(err?.issues.some((i) => i.path === "runner.metrics.auth.token")).toBe(true);
  });

  it("rejects unknown [runner.metrics.auth].kind values", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[runner.metrics.auth]
kind = "oauth"

[[pull.markdown]]
name     = "docs"
schedule = "every 5m"
path     = "./docs"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) => i.message.includes("unknown auth kind")),
    ).toBe(true);
  });

  it("loads [[push.gmail]] with path_token only (legacy auth)", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
path_token    = "tok"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    expect(loaded.config.push.gmail).toHaveLength(1);
    expect(loaded.config.push.gmail![0].path_token).toBe("tok");
    expect(loaded.config.push.gmail![0].oidc).toBeUndefined();
  });

  it("loads [[push.gmail]] with oidc inline-table only", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
oidc          = { audience = "https://runner.example.com/gmail/founder/events", expected_emails = ["sa@proj.iam.gserviceaccount.com"], leeway_sec = 30 }
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    const entry = loaded.config.push.gmail![0];
    expect(entry.path_token).toBeUndefined();
    expect(entry.oidc).toEqual({
      audience: "https://runner.example.com/gmail/founder/events",
      expected_emails: ["sa@proj.iam.gserviceaccount.com"],
      leeway_sec: 30,
    });
  });

  it("loads [[push.gmail]] with both path_token AND oidc (defense in depth)", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
path_token    = "tok"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
oidc          = { audience = "https://runner.example.com/gmail/founder/events" }
`;
    const loaded = await loadConfig({ rawTomlString: cfg, env: {} });
    const entry = loaded.config.push.gmail![0];
    expect(entry.path_token).toBe("tok");
    expect(entry.oidc?.audience).toBe("https://runner.example.com/gmail/founder/events");
  });

  it("rejects [[push.gmail]] with NEITHER path_token NOR oidc", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) =>
        i.message.includes("path_token") && i.message.includes("oidc"),
      ),
    ).toBe(true);
  });

  it("rejects [[push.gmail]] oidc table missing audience", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
oidc          = { expected_emails = ["sa@proj.iam.gserviceaccount.com"] }
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) => i.path.endsWith(".oidc.audience")),
    ).toBe(true);
  });

  it("rejects [[push.gmail]] oidc with negative leeway_sec", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
oidc          = { audience = "x", leeway_sec = -1 }
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) => i.path.endsWith(".oidc.leeway_sec")),
    ).toBe(true);
  });

  it("rejects [[push.gmail]] oidc with non-string expected_emails", async () => {
    const cfg = `
[statewave]
url = "http://localhost"

[[push.gmail]]
name          = "founder-pubsub"
client_id     = "x"
client_secret = "x"
refresh_token = "x"
oidc          = { audience = "x", expected_emails = [1, 2] }
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: cfg, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) => i.path.endsWith(".oidc.expected_emails")),
    ).toBe(true);
  });

  it("rejects unknown connector kinds with a helpful message", async () => {
    const bad = `
[statewave]
url = "http://localhost"

[[pull.banana]]
name     = "fruit"
schedule = "every 1h"
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: bad, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    const issue = err?.issues.find((i) => i.path === "pull.banana");
    expect(issue?.message).toContain("unknown pull connector");
    expect(issue?.message).toContain("github");
  });

  it("rejects pull.zapier (zapier is push-only / helper)", async () => {
    const bad = `
[statewave]
url = "http://localhost"

[[pull.zapier]]
name     = "z"
schedule = "every 1h"
`;
    await expect(
      loadConfig({ rawTomlString: bad, env: {} }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("zendesk requires either api-token mode OR oauth_token", async () => {
    const partial = `
[statewave]
url = "http://localhost"

[[pull.zendesk]]
name      = "acme"
schedule  = "every 1h"
subdomain = "acme"
# email + api_token + oauth_token all missing
`;
    let err: ConfigError | undefined;
    try {
      await loadConfig({ rawTomlString: partial, env: {} });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err?.code).toBe("validation_error");
    expect(
      err?.issues.some((i) =>
        i.message.includes("email + api_token") &&
        i.message.includes("oauth_token"),
      ),
    ).toBe(true);
  });
});
