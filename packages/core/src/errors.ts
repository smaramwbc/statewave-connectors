export type ConnectorErrorCode =
  | "config_invalid"
  | "auth_failed"
  | "auth_missing"
  | "rate_limited"
  | "network"
  | "not_found"
  | "permission_denied"
  | "mapping_failed"
  | "ingest_failed"
  | "unsupported"
  | "unknown";

export interface ConnectorErrorOptions {
  code: ConnectorErrorCode;
  connector?: string;
  hint?: string;
  cause?: unknown;
  retryable?: boolean;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly connector?: string;
  readonly hint?: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(message: string, options: ConnectorErrorOptions) {
    super(message);
    this.name = "ConnectorError";
    this.code = options.code;
    this.connector = options.connector;
    this.hint = options.hint;
    this.retryable = options.retryable ?? defaultRetryable(options.code);
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      connector: this.connector,
      hint: this.hint,
      retryable: this.retryable,
    };
  }
}

function defaultRetryable(code: ConnectorErrorCode): boolean {
  switch (code) {
    case "rate_limited":
    case "network":
      return true;
    default:
      return false;
  }
}
