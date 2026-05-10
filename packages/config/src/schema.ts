// Public type surface for the connectors config file.
//
// Multi-instance by design: every connector kind is an array
// (`[[pull.github]]`, `[[push.slack]]`, etc.) so a single deployment
// can ingest from two GitHub orgs, run two Zendesk subdomains, accept
// webhooks from prod + sandbox Slack, and so on. Each entry must carry
// a `name` that is unique within its kind — the runner uses
// `(connector_kind, name)` to key cursors and dedup state, and to mount
// push receivers at `/<connector>/<name>/events`.
//
// All secret-shaped fields support `${ENV_VAR}` interpolation and are
// resolved against `process.env` (or an injected env, for tests) at
// load time. Missing env vars fail fast with a list of every offender,
// not on first use.

/** Top-level config — what loadConfig() returns. */
export interface StatewaveConnectorsConfig {
  statewave: StatewaveServerConfig;
  runner: RunnerConfig;
  pull: PullConnectors;
  push: PushConnectors;
}

/** Statewave server connection — where ingest goes. */
export interface StatewaveServerConfig {
  /** v1 API base, e.g. `https://api.example.com`. Required. */
  url: string;
  /** Bearer token for the v1 API. Optional only for unauthenticated dev. */
  api_key?: string;
  /** Tenant id for multi-tenant deployments. Optional. */
  tenant_id?: string;
}

/** Runner-level operational settings. */
export interface RunnerConfig {
  /** HTTP port for push receivers + health endpoints. Default 3000. */
  port?: number;
  /** Bind address. Default `0.0.0.0`. */
  host?: string;
  /**
   * Filesystem dir where the runner persists cursors and dedup caches
   * across restarts. Used as the default location for the file-backed
   * state adapter; explicit per-adapter `path` in [runner.state] takes
   * precedence. Default `./var/connectors-state`.
   */
  state_dir?: string;
  /** `json` or `text`. Default `json` (one-line records, ops-friendly). */
  log_format?: "json" | "text";
  /**
   * Persistent state adapter — where the runner stores per-source pull
   * cursors so they survive restarts. Defaults to `kind = "memory"`
   * (lost on restart). Push-receiver dedup caches are still in-memory
   * in this release; their persistent shape is queued for a follow-up.
   */
  state?: RunnerStateConfig;
  /**
   * Prometheus metrics endpoint config. When omitted, `/metrics` is
   * still exposed but unauthenticated — fine for trusted-network
   * deployments (Kubernetes service mesh, internal VPC). Set `auth`
   * when the runner's HTTP port is reachable from the public internet.
   */
  metrics?: RunnerMetricsConfig;
}

/**
 * Prometheus metrics endpoint settings. The `/metrics` route is always
 * exposed; this block only governs auth and the path. To disable
 * metrics entirely, the runner takes a programmatic `metricsEnabled:
 * false` override — there's no config-file off-switch on purpose
 * (operators almost always want metrics, even if they're internal).
 */
export interface RunnerMetricsConfig {
  /** Optional path override. Default `/metrics`. */
  path?: string;
  /**
   * Auth on the metrics endpoint. Health probes (`/healthz`, `/readyz`)
   * stay unauthenticated regardless — orchestrators may not have
   * credentials. Default: no auth.
   */
  auth?: RunnerMetricsAuth;
}

export type RunnerMetricsAuth =
  | { kind: "none" }
  | { kind: "basic"; username: string; password: string }
  | { kind: "bearer"; token: string };

/**
 * Persistent state config — discriminated on `kind`.
 *
 * - `memory`     — in-memory only, lost on restart. Default.
 * - `file`       — atomic JSON-file write to `path` (defaults to
 *                  `<runner.state_dir>/cursors.json`). Right for single-
 *                  process daemons (Fly app, Railway service, single VM).
 * - `postgres`   — Postgres `statewave_runner_cursors` table via the
 *                  given `url`. Reuse the Statewave server's database
 *                  or a dedicated one. Right for multi-process daemons
 *                  behind a load balancer.
 * - `redis`      — Redis hash at `<key_prefix>cursors`. Same multi-
 *                  process story as Postgres; pick whichever the
 *                  operator's stack already has.
 */
export type RunnerStateConfig =
  | { kind: "memory" }
  | { kind: "file"; path?: string }
  | { kind: "postgres"; url: string; table?: string }
  | { kind: "redis"; url: string; key_prefix?: string };

/** Every supported pull-mode connector. Each kind is an array — multi-instance from day one. */
export interface PullConnectors {
  github?: ReadonlyArray<GithubPullConfig>;
  markdown?: ReadonlyArray<MarkdownPullConfig>;
  slack?: ReadonlyArray<SlackPullConfig>;
  n8n?: ReadonlyArray<N8nPullConfig>;
  discord?: ReadonlyArray<DiscordPullConfig>;
  zendesk?: ReadonlyArray<ZendeskPullConfig>;
  intercom?: ReadonlyArray<IntercomPullConfig>;
  freshdesk?: ReadonlyArray<FreshdeskPullConfig>;
  notion?: ReadonlyArray<NotionPullConfig>;
  gmail?: ReadonlyArray<GmailPullConfig>;
  // Note: `zapier` is push-only (helper, no pull surface) — intentionally not listed here.
}

/** Every supported push-mode connector. */
export interface PushConnectors {
  slack?: ReadonlyArray<SlackPushConfig>;
  freshdesk?: ReadonlyArray<FreshdeskPushConfig>;
  zendesk?: ReadonlyArray<ZendeskPushConfig>;
  intercom?: ReadonlyArray<IntercomPushConfig>;
  gmail?: ReadonlyArray<GmailPushConfig>;
}

// ─── Common fields every entry carries ────────────────────────────────────

/** Fields shared by every pull-mode source. */
export interface CommonPullFields {
  /**
   * Stable, human-readable id for this source. Required, unique within
   * its connector kind. Used to key cursor state and to disambiguate
   * sources in logs and metrics. Must match `[a-z0-9][a-z0-9_-]*`.
   */
  name: string;
  /**
   * Schedule string. Either:
   *   - `every <N><unit>`  where unit is `s` / `m` / `h` / `d`
   *     (e.g. `every 15m`, `every 1h`, `every 30s`)
   *   - 5-field POSIX cron (e.g. `0 *\/1 * * *`)
   * Required. Wave 1 only validates the string shape; Wave 2 hooks the scheduler.
   */
  schedule: string;
  /** Override the connector's default subject. Optional. */
  subject?: string;
  /** Cap mapped episodes per scheduled run. Optional. */
  max_items?: number;
  /**
   * If true, the runner runs the connector but skips the ingest call
   * (mirrors `--dry-run`). Useful for staging the runner before flipping
   * traffic. Default false.
   */
  dry_run?: boolean;
}

/** Fields shared by every push-mode receiver. */
export interface CommonPushFields {
  /**
   * Stable, human-readable id. Required, unique within its connector
   * kind. Mounts the receiver at `/<connector>/<name>/events`. Must
   * match `[a-z0-9][a-z0-9_-]*`.
   */
  name: string;
  /** Override the receiver's default subject. Optional. */
  subject?: string;
}

// ─── Pull-mode per-connector ─────────────────────────────────────────────

export interface GithubPullConfig extends CommonPullFields {
  /** owner/repo, e.g. `smaramwbc/statewave`. Required. */
  repo: string;
  token?: string;
  since_default?: string;
  include?: ReadonlyArray<string>;
  exclude?: ReadonlyArray<string>;
}

export interface MarkdownPullConfig extends CommonPullFields {
  /** Filesystem path the connector walks. Required. */
  path: string;
  include?: ReadonlyArray<string>;
  exclude?: ReadonlyArray<string>;
}

export interface SlackPullConfig extends CommonPullFields {
  bot_token: string;
  channels: ReadonlyArray<string>;
  include_dms?: boolean;
  include_mpim?: boolean;
  resolve_users?: boolean;
}

export interface N8nPullConfig extends CommonPullFields {
  instance_url: string;
  api_key: string;
  workflows?: ReadonlyArray<string>;
  include?: ReadonlyArray<string>;
}

export interface DiscordPullConfig extends CommonPullFields {
  bot_token: string;
  guild: string;
  channels: ReadonlyArray<string>;
}

export interface ZendeskPullConfig extends CommonPullFields {
  subdomain: string;
  /** API-token mode. Required when `oauth_token` is unset. */
  email?: string;
  api_token?: string;
  /** OAuth bearer mode. Required when `email` + `api_token` are unset. */
  oauth_token?: string;
  brands?: ReadonlyArray<number>;
  statuses?: ReadonlyArray<string>;
  use_incremental?: boolean;
  include?: ReadonlyArray<string>;
}

export interface IntercomPullConfig extends CommonPullFields {
  access_token: string;
  region?: "us" | "eu" | "au";
  app_id?: string;
  tags?: ReadonlyArray<string>;
  teams?: ReadonlyArray<string>;
  include?: ReadonlyArray<string>;
}

export interface FreshdeskPullConfig extends CommonPullFields {
  subdomain: string;
  api_key: string;
  include?: ReadonlyArray<string>;
}

export interface NotionPullConfig extends CommonPullFields {
  token: string;
  databases?: ReadonlyArray<string>;
  include?: ReadonlyArray<string>;
}

export interface GmailPullConfig extends CommonPullFields {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** Required — operators must scope the pull. */
  query: string;
  label_ids?: ReadonlyArray<string>;
}

// ─── Push-mode per-connector ─────────────────────────────────────────────

export interface SlackPushConfig extends CommonPushFields {
  signing_secret: string;
  channels: ReadonlyArray<string>;
  accept_dms?: boolean;
  accept_mpim?: boolean;
}

export interface FreshdeskPushConfig extends CommonPushFields {
  signing_secret: string;
  signing_header?: string;
  subdomain?: string;
}

export interface ZendeskPushConfig extends CommonPushFields {
  signing_secret: string;
  subdomain?: string;
  replay_window_sec?: number;
}

export interface IntercomPushConfig extends CommonPushFields {
  signing_secret: string;
  app_id?: string;
  region?: "us" | "eu" | "au";
}

export interface GmailPushConfig extends CommonPushFields {
  /**
   * Path-token in the Pub/Sub subscription URL. At least one of
   * `path_token` or `oidc` is required (operator can configure both
   * for defense in depth — both must pass).
   */
  path_token?: string;
  /**
   * Built-in OIDC verification (v0.3.0+). Pair with the matching
   * Pub/Sub subscription's "Authentication audience" setting.
   */
  oidc?: GmailPushOidcConfig;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  query?: string;
  label_ids?: ReadonlyArray<string>;
  max_items?: number;
}

/**
 * OIDC sub-config for `[[push.gmail]]`. The runner translates this into
 * the gmail receiver's `oidc` config at boot. Field names use snake_case
 * to match TOML conventions; the runner camelCase-renames at the
 * adapter boundary.
 */
export interface GmailPushOidcConfig {
  /** Expected `aud` claim — operator-chosen audience configured on the
   * Pub/Sub subscription's Authentication page. Required. */
  audience: string;
  /** Optional allowlist of `email` claims (service account addresses). */
  expected_emails?: ReadonlyArray<string>;
  /** Override the JWKs URL (testing). */
  jwks_uri?: string;
  /** Override the expected `iss` claim. */
  issuer?: string;
  /** Clock-skew leeway in seconds. Default 60. */
  leeway_sec?: number;
}
