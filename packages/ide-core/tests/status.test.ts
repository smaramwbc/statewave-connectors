import { describe, it, expect } from "vitest";
import { deriveStatus, type StatusInputs } from "../src/index.js";

const base: StatusInputs = {
  phase: "idle",
  compile: "idle",
  errors: 0,
};

describe("deriveStatus — reachability", () => {
  it("shows offline (error) when unreachable and not probing", () => {
    const m = deriveStatus({ ...base, online: false, reconnecting: false });
    expect(m.text).toBe("Statewave offline");
    expect(m.kind).toBe("error");
  });

  it("shows connecting (normal) while a probe is in flight and not yet online", () => {
    const m = deriveStatus({ ...base, online: false, reconnecting: true });
    expect(m.text).toBe("Statewave connecting…");
    expect(m.kind).toBe("normal");
    expect(m.tooltip).toContain("connecting");
  });

  it("connecting also applies from the unknown state (first probe at startup)", () => {
    const m = deriveStatus({ ...base, online: undefined, reconnecting: true });
    expect(m.text).toBe("Statewave connecting…");
    expect(m.kind).toBe("normal");
  });

  it("a probe in flight does NOT mask a known-online server", () => {
    // reconnecting true but already online (heartbeat) → keep the normal
    // ready/online rendering, not "connecting".
    const m = deriveStatus({
      ...base,
      online: true,
      reconnecting: true,
      memories: 12,
    });
    expect(m.text).toBe("Statewave: 12 memories ready");
    expect(m.kind).toBe("normal");
  });

  it("recovers to memories-ready once online and the probe finishes", () => {
    const m = deriveStatus({
      ...base,
      online: true,
      reconnecting: false,
      memories: 3,
    });
    expect(m.text).toBe("Statewave: 3 memories ready");
  });

  it("offline → connecting → online progression renders three distinct labels", () => {
    const offline = deriveStatus({ ...base, online: false, reconnecting: false });
    const connecting = deriveStatus({ ...base, online: false, reconnecting: true });
    const online = deriveStatus({ ...base, online: true, reconnecting: false, memories: 0 });
    expect(offline.text).toBe("Statewave offline");
    expect(connecting.text).toBe("Statewave connecting…");
    expect(online.text).not.toBe("Statewave offline");
    expect(online.text).not.toBe("Statewave connecting…");
  });
});
