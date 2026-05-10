import { describe, it, expect } from "vitest";
import { resolveConfigPath } from "../src/search-paths.js";

function existsFor(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe("resolveConfigPath", () => {
  it("explicit --config path wins when it exists", () => {
    const result = resolveConfigPath({
      configPath: "/etc/swc.toml",
      cwd: "/work",
      homeDir: "/home/u",
      env: { STATEWAVE_CONNECTORS_CONFIG: "/etc/from-env.toml" },
      exists: existsFor("/etc/swc.toml", "/etc/from-env.toml"),
    });
    expect(result.source).toBe("explicit");
    expect(result.path).toBe("/etc/swc.toml");
  });

  it("falls back to env var when no explicit path", () => {
    const result = resolveConfigPath({
      cwd: "/work",
      homeDir: "/home/u",
      env: { STATEWAVE_CONNECTORS_CONFIG: "/etc/from-env.toml" },
      exists: existsFor("/etc/from-env.toml"),
    });
    expect(result.source).toBe("env");
    expect(result.path).toBe("/etc/from-env.toml");
  });

  it("falls back to ./statewave-connectors.toml in cwd", () => {
    const result = resolveConfigPath({
      cwd: "/work",
      homeDir: "/home/u",
      env: {},
      exists: existsFor("/work/statewave-connectors.toml"),
    });
    expect(result.source).toBe("cwd");
    expect(result.path).toBe("/work/statewave-connectors.toml");
  });

  it("falls back to XDG_CONFIG_HOME, then ~/.config", () => {
    const xdg = resolveConfigPath({
      cwd: "/work",
      homeDir: "/home/u",
      env: { XDG_CONFIG_HOME: "/custom/xdg" },
      exists: existsFor("/custom/xdg/statewave-connectors/config.toml"),
    });
    expect(xdg.source).toBe("xdg");
    expect(xdg.path).toBe("/custom/xdg/statewave-connectors/config.toml");

    const homeDefault = resolveConfigPath({
      cwd: "/work",
      homeDir: "/home/u",
      env: {},
      exists: existsFor("/home/u/.config/statewave-connectors/config.toml"),
    });
    expect(homeDefault.source).toBe("xdg");
    expect(homeDefault.path).toBe("/home/u/.config/statewave-connectors/config.toml");
  });

  it("returns not_found with the full searched list when nothing exists", () => {
    const result = resolveConfigPath({
      cwd: "/work",
      homeDir: "/home/u",
      env: { STATEWAVE_CONNECTORS_CONFIG: "/etc/maybe.toml" },
      exists: existsFor(),
    });
    expect(result.source).toBe("not_found");
    expect(result.path).toBeNull();
    expect(result.searched.map((s) => s.source)).toEqual(["env", "cwd", "xdg"]);
  });
});
