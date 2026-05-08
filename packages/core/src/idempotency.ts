import { createHash } from "node:crypto";

export function idempotencyKey(parts: ReadonlyArray<string | number | undefined | null>): string {
  const normalized = parts
    .map((p) => (p === undefined || p === null ? "" : String(p)))
    .join("|");
  const hash = createHash("sha256").update(normalized).digest("hex");
  return hash.slice(0, 32);
}

export function namespacedKey(namespace: string, ...parts: ReadonlyArray<string | number | undefined | null>): string {
  return `${namespace}:${idempotencyKey(parts)}`;
}
