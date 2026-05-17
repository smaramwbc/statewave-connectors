/**
 * A tiny, dependency-free glob matcher.
 *
 * Supports the subset the companion needs for `includeGlobs` / `excludeGlobs`:
 *   - `**`  — any number of path segments (including zero)
 *   - `*`   — any run of characters except `/`
 *   - `?`   — a single character except `/`
 *   - everything else is literal
 *
 * Paths are matched POSIX-style; callers normalise separators first. This is
 * intentionally not full minimatch — connectors elsewhere in this repo use
 * substring filters, and a small, auditable matcher is safer than pulling a
 * dependency into a package that the IDE extension bundles.
 */

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // consume the second `*`
        if (glob[i + 1] === "/") {
          // `**/` → zero or more whole path segments.
          i++;
          re += "(?:[^/]+/)*";
        } else {
          // trailing / embedded `**` → anything, including `/`.
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map<string, RegExp>();

export function matchesGlob(relativePath: string, glob: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(relativePath);
}

export function matchesAnyGlob(
  relativePath: string,
  globs: ReadonlyArray<string>,
): boolean {
  return globs.some((g) => matchesGlob(relativePath, g));
}
