// Tiny structured logger for the runner.
//
// Two output modes, picked by `runner.log_format` in the config:
//   - `json`  — one record per line, machine-readable for ops pipelines
//   - `text`  — `[HH:MM:SS] level [source] msg key=val key=val`, human-readable
//
// Deliberately minimal: no rotation, no transports, no batching. The
// runner is a foreground process; operators are expected to redirect
// stdout to whatever their environment uses for log shipping.

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  /** Returns a child logger that prefixes every record with `source`. */
  withSource(source: string): Logger;
}

export interface CreateLoggerOptions {
  format: "json" | "text";
  /** Override the time source for tests. */
  now?: () => Date;
  /** Override the sink for tests. Defaults to console.log/warn/error. */
  write?: (level: LogLevel, line: string) => void;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const now = options.now ?? (() => new Date());
  const write =
    options.write ??
    ((level, line) => {
      // eslint-disable-next-line no-console
      const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
      sink(line);
    });

  function emit(
    level: LogLevel,
    source: string | undefined,
    msg: string,
    ctx?: Record<string, unknown>,
  ): void {
    const ts = now().toISOString();
    if (options.format === "json") {
      const record: Record<string, unknown> = { ts, level, msg };
      if (source) record.source = source;
      if (ctx) Object.assign(record, ctx);
      write(level, JSON.stringify(record));
      return;
    }
    const time = ts.slice(11, 19);
    const tag = source ? `[${source}] ` : "";
    let suffix = "";
    if (ctx) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(ctx)) {
        parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
      }
      if (parts.length > 0) suffix = "  " + parts.join(" ");
    }
    write(level, `[${time}] ${level.padEnd(5)} ${tag}${msg}${suffix}`);
  }

  function makeLogger(source?: string): Logger {
    return {
      info: (msg, ctx) => emit("info", source, msg, ctx),
      warn: (msg, ctx) => emit("warn", source, msg, ctx),
      error: (msg, ctx) => emit("error", source, msg, ctx),
      withSource: (s) => makeLogger(s),
    };
  }

  return makeLogger();
}
