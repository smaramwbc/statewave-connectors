// `formatZapToEpisode` — pure transformation from a Zapier webhook payload
// into a normalized Statewave episode. There is no Zapier "source connector"
// in the conventional sense — Zapier deliberately does not expose a public
// API for enumerating other zaps' run history, so the integration shape is:
//
//     User adds "Webhooks by Zapier → POST" as the last step of their zap.
//     The POST goes to Statewave's /v1/episodes/batch endpoint (directly), or
//     to a small server they run themselves that uses this helper to massage
//     the payload before forwarding.
//
// This module covers the second case. The first case is fully documented in
// the package README and needs no code from us.

import { ConnectorError, EpisodeBuilder, type StatewaveEpisode } from "@statewavedev/connectors-core";

export type ZapStatus = "success" | "failure" | "in_progress" | string;

export type ZapEventKind = "zapier.zap.executed" | "zapier.zap.failed";

/**
 * The recommended payload shape we ask users to configure in their Zap's
 * Webhooks-by-Zapier step. Required fields are the bare minimum to produce a
 * meaningful episode; everything else is optional and flows through to
 * `metadata.data` so downstream agents can read it without us prescribing
 * the schema.
 */
export interface ZapEpisodeInput {
  /** Memory subject. Required because it has no sensible default — the user
   * knows whether the zap operates on a customer, workflow, or team. */
  subject: string;
  /** Zapier zap id (visible in the URL on zapier.com when editing). */
  zap_id: string;
  /** Optional zap display name; rendered in episode text when present. */
  zap_name?: string;
  /** Per-run id from `{{zap_meta__id}}` — disambiguates multiple runs of the
   * same zap. Required so we can build a stable idempotency key. */
  run_id: string;
  /** Run status — `"success"` or `"failure"` are the canonical values; any
   * other string is treated as failure for routing purposes but kept verbatim
   * in metadata. */
  status: ZapStatus;
  /** ISO-8601 timestamp. Falls back to `new Date()` when omitted. */
  occurred_at?: string;
  /** Optional pre-rendered episode text. Falls back to a synthesized headline
   * built from `zap_name` + `status`. */
  text?: string;
  /** Anything else the user wants to remember about the run — input snippets,
   * record ids, output summaries — kept opaque under `metadata.data`. */
  data?: Record<string, unknown>;
}

export interface FormatOptions {
  /** Override the input's subject without mutating the input. Useful for
   * server-side routing. */
  subject?: string;
  /** Optional URL to attach as `source.url`. Most useful when the user has a
   * canonical zap URL (e.g. `https://zapier.com/app/zaps/12345`). */
  url?: string;
}

/**
 * Build a `StatewaveEpisode` from a Zapier webhook payload. Pure — no IO. */
export function formatZapToEpisode(
  input: ZapEpisodeInput,
  options: FormatOptions = {},
): StatewaveEpisode {
  if (!input || typeof input !== "object") {
    throw new ConnectorError("formatZapToEpisode requires an object payload", {
      code: "mapping_failed",
      connector: "zapier",
    });
  }
  const { subject, zap_id, run_id, status } = input;
  const missing: string[] = [];
  if (!options.subject && !subject) missing.push("subject");
  if (!zap_id) missing.push("zap_id");
  if (!run_id) missing.push("run_id");
  if (!status) missing.push("status");
  if (missing.length > 0) {
    throw new ConnectorError(
      `formatZapToEpisode payload missing required fields: ${missing.join(", ")}`,
      {
        code: "mapping_failed",
        connector: "zapier",
        hint: "configure these fields in the Zapier 'Webhooks by Zapier → POST' body — see the package README",
      },
    );
  }

  const isFailure = status !== "success";
  const kind: ZapEventKind = isFailure ? "zapier.zap.failed" : "zapier.zap.executed";

  const headline = isFailure
    ? `Zap "${input.zap_name ?? input.zap_id}" failed (${status})`
    : `Zap "${input.zap_name ?? input.zap_id}" ran successfully`;
  const text = input.text ?? `${headline} [run=${input.run_id}]`;

  const builder = new EpisodeBuilder({
    subject: options.subject ?? subject,
    metadata: {
      zap_id,
      zap_name: input.zap_name,
      zap_status: status,
    },
  });

  return builder.build({
    kind,
    text,
    occurred_at: input.occurred_at,
    source: {
      type: "zapier.zap_run",
      id: `${zap_id}:${run_id}`,
      url: options.url,
    },
    metadata: {
      run_id,
      data: input.data,
    },
    idempotency_parts: ["zapier", zap_id, run_id, kind],
  });
}
