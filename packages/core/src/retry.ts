import { ConnectorError } from "./errors.js";

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const DEFAULTS = {
  retries: 3,
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  factor: 2,
  jitter: true,
};

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const cfg = { ...DEFAULTS, ...options };
  let attempt = 0;

  while (true) {
    if (cfg.signal?.aborted) {
      throw new ConnectorError("Operation aborted", { code: "unknown", retryable: false });
    }
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < cfg.retries && shouldRetryError(err, attempt, cfg.shouldRetry);
      if (!canRetry) throw err;

      const delay = computeDelay(attempt, cfg);
      cfg.onRetry?.(err, attempt + 1, delay);
      await sleep(delay, cfg.signal);
      attempt += 1;
    }
  }
}

function shouldRetryError(
  err: unknown,
  attempt: number,
  custom?: (err: unknown, attempt: number) => boolean
): boolean {
  if (custom) return custom(err, attempt);
  if (err instanceof ConnectorError) return err.retryable;
  return true;
}

function computeDelay(attempt: number, cfg: Required<Omit<RetryOptions, "signal" | "shouldRetry" | "onRetry">>): number {
  const exp = cfg.baseDelayMs * Math.pow(cfg.factor, attempt);
  const capped = Math.min(exp, cfg.maxDelayMs);
  if (!cfg.jitter) return capped;
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ConnectorError("Aborted", { code: "unknown", retryable: false }));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ConnectorError("Aborted", { code: "unknown", retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
