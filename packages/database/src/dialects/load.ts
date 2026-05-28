import { ConnectorError } from "@statewavedev/connectors-core";

/**
 * Lazily import an optional DB driver. The module specifier is a *variable* on
 * purpose: TypeScript can't statically resolve it, so the workspace builds
 * without the heavy drivers installed. End users install only the driver for
 * their dialect (declared as an optional peer dependency).
 */
export async function importDriver(name: string): Promise<Record<string, unknown>> {
  try {
    const mod = (await import(name)) as Record<string, unknown>;
    // Unwrap CJS default-interop so callers see a flat namespace.
    const def = mod["default"];
    if (def && typeof def === "object") {
      return { ...(def as Record<string, unknown>), ...mod };
    }
    return mod;
  } catch (err) {
    throw new ConnectorError(`the '${name}' driver is not installed`, {
      code: "config_invalid",
      connector: "database",
      hint: `install it as a peer dependency: npm install ${name}`,
      cause: err,
    });
  }
}
