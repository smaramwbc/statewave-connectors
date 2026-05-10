// Validation pass — turns a parsed-and-interpolated TOML object into a
// typed `StatewaveConnectorsConfig`, OR a list of every problem found.
//
// Design: collect ALL issues in one pass, never throw on the first one.
// Operators editing a multi-source config want the full punch list, not
// edit-run-edit-run. The loader translates a non-empty issue list into
// a single ConfigError with `code: "validation_error"`.

import type {
  CommonPullFields,
  CommonPushFields,
  DiscordPullConfig,
  FreshdeskPullConfig,
  FreshdeskPushConfig,
  GithubPullConfig,
  GmailPullConfig,
  GmailPushConfig,
  IntercomPullConfig,
  IntercomPushConfig,
  MarkdownPullConfig,
  N8nPullConfig,
  NotionPullConfig,
  PullConnectors,
  PushConnectors,
  RunnerConfig,
  SlackPullConfig,
  SlackPushConfig,
  StatewaveConnectorsConfig,
  StatewaveServerConfig,
  ZendeskPullConfig,
  ZendeskPushConfig,
} from "./schema.js";
import type { RunnerStateConfig } from "./schema.js";
import type { ValidationIssue } from "./errors.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const HUMAN_SCHEDULE = /^every\s+\d+\s*[smhd]$/i;
// 5-field cron, very permissive — Wave 2 does the real parse.
const CRON_5_FIELD = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export interface ValidateResult {
  config?: StatewaveConnectorsConfig;
  issues: ReadonlyArray<ValidationIssue>;
}

export function validate(raw: unknown): ValidateResult {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(raw)) {
    issues.push({ path: "", message: "config root must be a TOML table" });
    return { issues };
  }

  const root = raw as Record<string, unknown>;
  const statewave = validateStatewave(root.statewave, "statewave", issues);
  const runner = validateRunner(root.runner, "runner", issues);
  const pull = validatePull(root.pull, "pull", issues);
  const push = validatePush(root.push, "push", issues);

  if (issues.length > 0) return { issues };
  return {
    config: { statewave, runner, pull, push },
    issues: [],
  };
}

// ─── statewave / runner blocks ────────────────────────────────────────────

function validateStatewave(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): StatewaveServerConfig {
  if (!isPlainObject(raw)) {
    issues.push({ path, message: `missing required [${path}] table` });
    return { url: "" };
  }
  const obj = raw as Record<string, unknown>;
  const out: StatewaveServerConfig = { url: "" };
  if (typeof obj.url === "string" && obj.url.length > 0) {
    out.url = obj.url;
  } else {
    issues.push({ path: `${path}.url`, message: "required string" });
  }
  if (obj.api_key !== undefined) {
    if (typeof obj.api_key !== "string") {
      issues.push({ path: `${path}.api_key`, message: "must be a string" });
    } else {
      out.api_key = obj.api_key;
    }
  }
  if (obj.tenant_id !== undefined) {
    if (typeof obj.tenant_id !== "string") {
      issues.push({ path: `${path}.tenant_id`, message: "must be a string" });
    } else {
      out.tenant_id = obj.tenant_id;
    }
  }
  return out;
}

function validateRunner(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): RunnerConfig {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issues.push({ path, message: `[${path}] must be a TOML table` });
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: RunnerConfig = {};
  if (obj.port !== undefined) {
    if (!Number.isInteger(obj.port) || (obj.port as number) <= 0) {
      issues.push({ path: `${path}.port`, message: "must be a positive integer" });
    } else {
      out.port = obj.port as number;
    }
  }
  if (obj.host !== undefined) {
    if (typeof obj.host !== "string") {
      issues.push({ path: `${path}.host`, message: "must be a string" });
    } else {
      out.host = obj.host;
    }
  }
  if (obj.state_dir !== undefined) {
    if (typeof obj.state_dir !== "string") {
      issues.push({ path: `${path}.state_dir`, message: "must be a string" });
    } else {
      out.state_dir = obj.state_dir;
    }
  }
  if (obj.log_format !== undefined) {
    if (obj.log_format !== "json" && obj.log_format !== "text") {
      issues.push({
        path: `${path}.log_format`,
        message: "must be one of: json, text",
      });
    } else {
      out.log_format = obj.log_format;
    }
  }
  if (obj.state !== undefined) {
    const state = validateRunnerState(obj.state, `${path}.state`, issues);
    if (state) out.state = state;
  }
  return out;
}

function validateRunnerState(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): RunnerStateConfig | undefined {
  if (!isPlainObject(raw)) {
    issues.push({ path, message: `[${path}] must be a TOML table` });
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === undefined) {
    issues.push({
      path: `${path}.kind`,
      message: 'required — one of: "memory", "file", "postgres", "redis"',
    });
    return undefined;
  }
  switch (kind) {
    case "memory":
      return { kind: "memory" };
    case "file": {
      const out: { kind: "file"; path?: string } = { kind: "file" };
      if (obj.path !== undefined) {
        if (typeof obj.path !== "string") {
          issues.push({ path: `${path}.path`, message: "must be a string" });
        } else {
          out.path = obj.path;
        }
      }
      return out;
    }
    case "postgres": {
      const out: { kind: "postgres"; url: string; table?: string } = {
        kind: "postgres",
        url: "",
      };
      if (typeof obj.url === "string" && obj.url.length > 0) {
        out.url = obj.url;
      } else {
        issues.push({
          path: `${path}.url`,
          message: "required for kind=postgres",
        });
      }
      if (obj.table !== undefined) {
        if (typeof obj.table !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(obj.table)) {
          issues.push({
            path: `${path}.table`,
            message: "must be a SQL-safe identifier (letters, digits, underscore)",
          });
        } else {
          out.table = obj.table;
        }
      }
      return out;
    }
    case "redis": {
      const out: { kind: "redis"; url: string; key_prefix?: string } = {
        kind: "redis",
        url: "",
      };
      if (typeof obj.url === "string" && obj.url.length > 0) {
        out.url = obj.url;
      } else {
        issues.push({
          path: `${path}.url`,
          message: "required for kind=redis",
        });
      }
      if (obj.key_prefix !== undefined) {
        if (typeof obj.key_prefix !== "string") {
          issues.push({ path: `${path}.key_prefix`, message: "must be a string" });
        } else {
          out.key_prefix = obj.key_prefix;
        }
      }
      return out;
    }
    default:
      issues.push({
        path: `${path}.kind`,
        message: `unknown state kind "${String(kind)}". Supported: memory, file, postgres, redis`,
      });
      return undefined;
  }
}

// ─── pull / push dispatch ─────────────────────────────────────────────────

interface PullConnectorSpec {
  required: ReadonlyArray<string>;
  /** Validate after the common pull fields have been checked. Push
   * issues onto the shared list. */
  extra?: (entry: Record<string, unknown>, path: string, issues: ValidationIssue[]) => void;
}

interface PushConnectorSpec {
  required: ReadonlyArray<string>;
  extra?: (entry: Record<string, unknown>, path: string, issues: ValidationIssue[]) => void;
}

const PULL_SPECS: Record<keyof PullConnectors, PullConnectorSpec> = {
  github: { required: ["repo"] },
  markdown: { required: ["path"] },
  slack: { required: ["bot_token", "channels"] },
  n8n: { required: ["instance_url", "api_key"] },
  discord: { required: ["bot_token", "guild", "channels"] },
  zendesk: {
    required: ["subdomain"],
    extra: (e, path, issues) => {
      const hasApiToken = isString(e.email) && isString(e.api_token);
      const hasOAuth = isString(e.oauth_token);
      if (!hasApiToken && !hasOAuth) {
        issues.push({
          path,
          message:
            "zendesk requires either (email + api_token) or oauth_token",
        });
      }
      if (e.region !== undefined && !["us", "eu", "au"].includes(e.region as string)) {
        issues.push({ path: `${path}.region`, message: "must be us / eu / au" });
      }
    },
  },
  intercom: {
    required: ["access_token"],
    extra: (e, path, issues) => {
      if (e.region !== undefined && !["us", "eu", "au"].includes(e.region as string)) {
        issues.push({ path: `${path}.region`, message: "must be us / eu / au" });
      }
    },
  },
  freshdesk: { required: ["subdomain", "api_key"] },
  notion: { required: ["token"] },
  gmail: {
    required: ["client_id", "client_secret", "refresh_token", "query"],
  },
};

const PUSH_SPECS: Record<keyof PushConnectors, PushConnectorSpec> = {
  slack: { required: ["signing_secret", "channels"] },
  freshdesk: { required: ["signing_secret"] },
  zendesk: {
    required: ["signing_secret"],
    extra: (e, path, issues) => {
      if (
        e.replay_window_sec !== undefined &&
        (!Number.isInteger(e.replay_window_sec) ||
          (e.replay_window_sec as number) <= 0)
      ) {
        issues.push({
          path: `${path}.replay_window_sec`,
          message: "must be a positive integer (seconds)",
        });
      }
    },
  },
  intercom: {
    required: ["signing_secret"],
    extra: (e, path, issues) => {
      if (e.region !== undefined && !["us", "eu", "au"].includes(e.region as string)) {
        issues.push({ path: `${path}.region`, message: "must be us / eu / au" });
      }
    },
  },
  gmail: {
    required: ["path_token", "client_id", "client_secret", "refresh_token"],
  },
};

function validatePull(
  raw: unknown,
  pathPrefix: string,
  issues: ValidationIssue[],
): PullConnectors {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issues.push({ path: pathPrefix, message: `[${pathPrefix}] must be a TOML table` });
    return {};
  }
  const out: PullConnectors = {};
  const obj = raw as Record<string, unknown>;
  for (const kind of Object.keys(obj) as Array<keyof PullConnectors>) {
    const spec = PULL_SPECS[kind];
    if (!spec) {
      issues.push({
        path: `${pathPrefix}.${kind}`,
        message:
          `unknown pull connector. Supported: ${Object.keys(PULL_SPECS).join(", ")}`,
      });
      continue;
    }
    const arr = obj[kind];
    if (!Array.isArray(arr)) {
      issues.push({
        path: `${pathPrefix}.${kind}`,
        message: `must be an array of TOML tables (use [[${pathPrefix}.${kind}]])`,
      });
      continue;
    }
    const entries: Record<string, unknown>[] = [];
    const seenNames = new Set<string>();
    for (let i = 0; i < arr.length; i += 1) {
      const entryPath = `${pathPrefix}.${kind}[${i}]`;
      const entry = arr[i];
      if (!isPlainObject(entry)) {
        issues.push({ path: entryPath, message: "must be a TOML table" });
        continue;
      }
      const e = entry as Record<string, unknown>;
      validateCommonPull(e, entryPath, issues);
      checkRequired(e, spec.required, entryPath, issues);
      spec.extra?.(e, entryPath, issues);
      checkUniqueName(e, seenNames, entryPath, issues);
      entries.push(e);
    }
    // The `as` cast is safe — checkRequired + validateCommonPull have
    // populated the issue list for any entry that's not actually shaped
    // like the type. Callers receive the partial array unless issues
    // is empty (in which case the loader bails before returning). The
    // wider Record cast sidesteps TS's intersection-of-arrays issue
    // when indexing PullConnectors with a `keyof` union.
    (out as Record<string, unknown>)[kind] = entries;
  }
  return out;
}

function validatePush(
  raw: unknown,
  pathPrefix: string,
  issues: ValidationIssue[],
): PushConnectors {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    issues.push({ path: pathPrefix, message: `[${pathPrefix}] must be a TOML table` });
    return {};
  }
  const out: PushConnectors = {};
  const obj = raw as Record<string, unknown>;
  for (const kind of Object.keys(obj) as Array<keyof PushConnectors>) {
    const spec = PUSH_SPECS[kind];
    if (!spec) {
      issues.push({
        path: `${pathPrefix}.${kind}`,
        message:
          `unknown push connector. Supported: ${Object.keys(PUSH_SPECS).join(", ")}`,
      });
      continue;
    }
    const arr = obj[kind];
    if (!Array.isArray(arr)) {
      issues.push({
        path: `${pathPrefix}.${kind}`,
        message: `must be an array of TOML tables (use [[${pathPrefix}.${kind}]])`,
      });
      continue;
    }
    const entries: Record<string, unknown>[] = [];
    const seenNames = new Set<string>();
    for (let i = 0; i < arr.length; i += 1) {
      const entryPath = `${pathPrefix}.${kind}[${i}]`;
      const entry = arr[i];
      if (!isPlainObject(entry)) {
        issues.push({ path: entryPath, message: "must be a TOML table" });
        continue;
      }
      const e = entry as Record<string, unknown>;
      validateCommonPush(e, entryPath, issues);
      checkRequired(e, spec.required, entryPath, issues);
      spec.extra?.(e, entryPath, issues);
      checkUniqueName(e, seenNames, entryPath, issues);
      entries.push(e);
    }
    (out as Record<string, unknown>)[kind] = entries;
  }
  return out;
}

// ─── shared helpers ───────────────────────────────────────────────────────

function validateCommonPull(
  e: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  validateName(e, path, issues);
  if (e.schedule === undefined || typeof e.schedule !== "string") {
    issues.push({ path: `${path}.schedule`, message: "required string" });
  } else if (!HUMAN_SCHEDULE.test(e.schedule) && !CRON_5_FIELD.test(e.schedule)) {
    issues.push({
      path: `${path}.schedule`,
      message:
        "must match `every <N><s|m|h|d>` (e.g. `every 15m`) or 5-field cron (e.g. `0 */1 * * *`)",
    });
  }
  validateOptionalCommonPull(e, path, issues);
}

function validateOptionalCommonPull(
  e: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (e.subject !== undefined && typeof e.subject !== "string") {
    issues.push({ path: `${path}.subject`, message: "must be a string" });
  }
  if (
    e.max_items !== undefined &&
    (!Number.isInteger(e.max_items) || (e.max_items as number) <= 0)
  ) {
    issues.push({ path: `${path}.max_items`, message: "must be a positive integer" });
  }
  if (e.dry_run !== undefined && typeof e.dry_run !== "boolean") {
    issues.push({ path: `${path}.dry_run`, message: "must be a boolean" });
  }
}

function validateCommonPush(
  e: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  validateName(e, path, issues);
  if (e.subject !== undefined && typeof e.subject !== "string") {
    issues.push({ path: `${path}.subject`, message: "must be a string" });
  }
}

function validateName(
  e: Record<string, unknown>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (e.name === undefined) {
    issues.push({ path: `${path}.name`, message: "required string" });
  } else if (typeof e.name !== "string") {
    issues.push({ path: `${path}.name`, message: "must be a string" });
  } else if (!NAME_PATTERN.test(e.name)) {
    issues.push({
      path: `${path}.name`,
      message: "must match [a-z0-9][a-z0-9_-]* (used to key state and mount push paths)",
    });
  }
}

function checkRequired(
  e: Record<string, unknown>,
  required: ReadonlyArray<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const field of required) {
    const value = e[field];
    if (value === undefined) {
      issues.push({ path: `${path}.${field}`, message: "required" });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        issues.push({ path: `${path}.${field}`, message: "required (non-empty array)" });
      } else if (!value.every((v) => typeof v === "string" || typeof v === "number")) {
        issues.push({
          path: `${path}.${field}`,
          message: "array entries must be strings or numbers",
        });
      }
    } else if (typeof value !== "string" && typeof value !== "number") {
      issues.push({ path: `${path}.${field}`, message: "must be a string" });
    }
  }
}

function checkUniqueName(
  e: Record<string, unknown>,
  seenNames: Set<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof e.name !== "string") return;
  if (seenNames.has(e.name)) {
    issues.push({
      path: `${path}.name`,
      message: `duplicate name "${e.name}" within this connector kind`,
    });
  } else {
    seenNames.add(e.name);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// Exported only so the loader can spell out the full type when the
// generic dispatch above coerces the entries.
export type {
  CommonPullFields,
  CommonPushFields,
  DiscordPullConfig,
  FreshdeskPullConfig,
  FreshdeskPushConfig,
  GithubPullConfig,
  GmailPullConfig,
  GmailPushConfig,
  IntercomPullConfig,
  IntercomPushConfig,
  MarkdownPullConfig,
  N8nPullConfig,
  NotionPullConfig,
  SlackPullConfig,
  SlackPushConfig,
  ZendeskPullConfig,
  ZendeskPushConfig,
};
