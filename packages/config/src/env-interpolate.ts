// Env-var interpolation for config values.
//
// Supported syntaxes (matched left-to-right in a single pass):
//   ${VAR}             — required; missing var is reported as an error
//   ${VAR:-fallback}   — fallback used when var is unset OR empty string
//   $$                 — literal `$` (escape hatch when a value really
//                        does need a `$` followed by `{` for some reason)
//
// The interpolator walks every string field in the parsed TOML tree and
// replaces matches in-place. It deliberately does NOT support command
// substitution (`$(...)`) or arbitrary shell features — secrets stay in
// env, no eval surface.

const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(:-([^}]*))?\}/g;

export interface InterpolateResult {
  /** Set of `${VAR}` references in required form whose env entry was
   * missing or empty. The caller fails fast and prints them. */
  missing: ReadonlyArray<string>;
}

/**
 * Walk an arbitrary parsed-TOML value and replace every `${VAR}` /
 * `${VAR:-fallback}` reference in every string. Mutates `node` in place
 * and returns the list of missing-required env vars discovered along the
 * way. Non-string values (numbers, booleans, arrays of non-strings) pass
 * through untouched.
 */
export function interpolate(
  node: unknown,
  env: Record<string, string | undefined>,
): InterpolateResult {
  const missing = new Set<string>();
  visit(node, env, missing);
  return { missing: [...missing] };
}

function visit(
  node: unknown,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): unknown {
  if (typeof node === "string") {
    return interpolateString(node, env, missing);
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      node[i] = visit(node[i], env, missing);
    }
    return node;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      obj[k] = visit(obj[k], env, missing);
    }
    return obj;
  }
  return node;
}

function interpolateString(
  raw: string,
  env: Record<string, string | undefined>,
  missing: Set<string>,
): string {
  // Handle the `$$` escape first by carving the string at literal `$$`
  // boundaries and rejoining with a real `$` after we've expanded each
  // segment. This keeps placeholder regex stateless.
  const segments = raw.split("$$");
  const expanded = segments.map((seg) =>
    seg.replace(PLACEHOLDER, (_match, name: string, _whole, fallback?: string) => {
      const value = env[name];
      if (value !== undefined && value !== "") return value;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      // Leave the placeholder in place so a partial expansion result
      // doesn't accidentally read like a real value (e.g. an empty
      // string that happens to look valid). The caller should bail
      // before any of these reach a connector.
      return _match;
    }),
  );
  return expanded.join("$");
}
