/**
 * Pure reachability helpers — the health-check URL and the poll cadence.
 *
 * The extension owns the timer + the `fetch`; this module owns the
 * deterministic decisions (which URL, how long until the next probe) so they
 * are unit-tested without an editor host or a network. Mirrors the split used
 * by `status.ts` (pure derivation) vs the status bar (rendering).
 */

/** Re-probe cadence when the server is unreachable — fast recovery. */
export const OFFLINE_PROBE_MS = 30_000;

/** Heartbeat cadence when the server is reachable — cheap liveness check. */
export const ONLINE_HEARTBEAT_MS = 5 * 60_000;

/**
 * Delay until the next reachability probe, given the last known online state.
 *
 * - Reachable → heartbeat slowly (5 min): we only need to notice if it *drops*.
 * - Unreachable or unknown → probe quickly (30 s): the user is waiting for
 *   "it's back" the moment they restart the server, and must not have to
 *   reload the window.
 */
export function nextProbeDelayMs(online: boolean | undefined): number {
  return online === true ? ONLINE_HEARTBEAT_MS : OFFLINE_PROBE_MS;
}

/**
 * Build the health-check URL from a configured base URL.
 *
 * Uses `/readyz` — the documented readiness endpoint that checks the API
 * **and** its database — rather than the bare base URL (which returns 404 from
 * the FastAPI root and only proves the process is listening, not that it can
 * serve). Trailing slashes on the base are normalised so we never produce
 * `http://host//readyz`.
 */
export function readyzUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/readyz`;
}
