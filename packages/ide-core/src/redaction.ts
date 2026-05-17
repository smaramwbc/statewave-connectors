import {
  redact,
  redactEpisodeText,
  type RedactionOptions,
  type StatewaveEpisode,
} from "@statewavedev/connectors-core";

/**
 * Translate the single `statewave.redaction.enabled` setting into the
 * connectors-core `RedactionOptions`. When enabled we turn on every
 * best-effort rule (email, phone, API-key/secret shapes) — the IDE companion
 * touches local source and docs, so the conservative default once a user
 * opts in is "scrub everything we know how to scrub".
 *
 * This is a deliberate reuse of the existing connector-core redaction
 * primitives rather than a parallel implementation.
 */
export function redactionOptionsFor(enabled: boolean): RedactionOptions | undefined {
  if (!enabled) return undefined;
  return { email: true, phone: true, secrets: true };
}

/** Apply redaction to a single episode's text, if enabled. */
export function applyRedaction(
  episode: StatewaveEpisode,
  enabled: boolean,
): StatewaveEpisode {
  const opts = redactionOptionsFor(enabled);
  return opts ? redactEpisodeText(episode, opts) : episode;
}

/** Redact a raw string (used for diagnostic messages before they become episodes). */
export function redactText(text: string, enabled: boolean): string {
  const opts = redactionOptionsFor(enabled);
  return opts ? redact(text, opts) : text;
}
