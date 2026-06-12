import { describe, it, expect } from "vitest";
import {
  parseNodeMajor,
  nodeMeetsMinimum,
  classifyDockerError,
  dockerFixHint,
} from "../src/commands/preflight.js";

describe("node version checks", () => {
  it("parses majors", () => {
    expect(parseNodeMajor("v20.11.1")).toBe(20);
    expect(parseNodeMajor("18.19.0")).toBe(18);
    expect(parseNodeMajor("garbage")).toBe(0);
  });
  it("enforces the minimum", () => {
    expect(nodeMeetsMinimum("v20.0.0")).toBe(true);
    expect(nodeMeetsMinimum("v22.1.0")).toBe(true);
    expect(nodeMeetsMinimum("v18.20.0")).toBe(false);
  });
});

describe("classifyDockerError", () => {
  it("detects a stopped daemon", () => {
    expect(
      classifyDockerError("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"),
    ).toBe("daemon-down");
    expect(classifyDockerError("error during connect: ... The system cannot find the file specified.")).toBe("daemon-down");
  });
  it("detects permission denied", () => {
    expect(
      classifyDockerError("Got permission denied while trying to connect to the Docker daemon socket"),
    ).toBe("denied");
  });
});

describe("dockerFixHint (OS-specific)", () => {
  it("daemon-down hints differ per OS", () => {
    expect(dockerFixHint("daemon-down", "darwin").join(" ")).toContain("open -a Docker");
    expect(dockerFixHint("daemon-down", "linux").join(" ")).toContain("systemctl start docker");
    expect(dockerFixHint("daemon-down", "win32").join(" ")).toContain("Docker Desktop");
  });
  it("no-cli points at the right installer per OS", () => {
    expect(dockerFixHint("no-cli", "darwin").join(" ")).toContain("desktop/install/mac");
    expect(dockerFixHint("no-cli", "linux").join(" ")).toContain("engine/install");
  });
  it("denied gives the docker-group fix on linux", () => {
    expect(dockerFixHint("denied", "linux").join(" ")).toContain("usermod -aG docker");
  });
  it("ok has no hints", () => {
    expect(dockerFixHint("ok")).toEqual([]);
  });
});
