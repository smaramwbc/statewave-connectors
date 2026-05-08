export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

export function flagAsString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (typeof v === "string") return v;
  return undefined;
}

export function flagAsBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

export function flagAsList(args: ParsedArgs, name: string): string[] | undefined {
  const v = flagAsString(args, name);
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function flagAsInt(args: ParsedArgs, name: string): number | undefined {
  const v = flagAsString(args, name);
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
