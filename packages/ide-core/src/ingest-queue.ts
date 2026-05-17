/**
 * Bounded-concurrency ingest queue with retry/backoff, progress, and
 * cancellation. Pure: it drives an injected `ingestOne` function (the
 * extension passes one backed by `StatewaveClient`), so it is fully
 * unit-testable without a network or a VS Code host.
 */

export interface IngestQueueOptions {
  /** Max in-flight ingests. Default 6. */
  concurrency?: number;
  /** Max attempts per item (incl. the first). Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential: base * 2^(attempt-1)). Default 250. */
  backoffBaseMs?: number;
  /** Injectable sleep (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  /** Progress callback, fired after every settled item. */
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestProgress {
  total: number;
  done: number;
  ok: number;
  failed: number;
  inFlight: number;
}

export interface IngestQueueResult {
  total: number;
  ok: number;
  failed: number;
  cancelled: boolean;
  /** First error message seen, for a compact UI summary. */
  errorSample?: string;
}

/** Cancellation token — the extension wires this to a VS Code CancellationToken. */
export class CancellationFlag {
  private flag = false;
  cancel(): void {
    this.flag = true;
  }
  get cancelled(): boolean {
    return this.flag;
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  // ConnectorError carries `retryable`; anything else: retry network-ish only.
  const e = err as { retryable?: boolean; code?: string };
  if (typeof e?.retryable === "boolean") return e.retryable;
  return e?.code === "network" || e?.code === "rate_limited";
}

/**
 * Ingest `items` with bounded concurrency. Each item is retried with
 * exponential backoff on retryable errors. A failing item never blocks the
 * rest (graceful partial failure). Honors cancellation between items.
 */
export async function runIngestQueue<T>(
  items: ReadonlyArray<T>,
  ingestOne: (item: T) => Promise<void>,
  options: IngestQueueOptions = {},
  cancel?: CancellationFlag,
): Promise<IngestQueueResult> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const base = options.backoffBaseMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;

  const total = items.length;
  let ok = 0;
  let failed = 0;
  let done = 0;
  let inFlight = 0;
  let errorSample: string | undefined;
  let cursor = 0;

  const report = (): void => {
    options.onProgress?.({ total, done, ok, failed, inFlight });
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (cancel?.cancelled) return;
      const i = cursor++;
      if (i >= total) return;
      const item = items[i] as T;
      inFlight++;
      let attempt = 0;
      while (true) {
        attempt++;
        try {
          await ingestOne(item);
          ok++;
          break;
        } catch (err) {
          if (attempt < maxAttempts && isRetryable(err) && !cancel?.cancelled) {
            await sleep(base * 2 ** (attempt - 1));
            continue;
          }
          failed++;
          if (!errorSample) {
            errorSample = err instanceof Error ? err.message : String(err);
          }
          break;
        }
      }
      inFlight--;
      done++;
      report();
    }
  };

  report();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total || 1) }, () => worker()),
  );

  return {
    total,
    ok,
    failed,
    cancelled: !!cancel?.cancelled,
    errorSample,
  };
}
