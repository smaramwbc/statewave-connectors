import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { Output } from "../src/output.js";

describe("Output", () => {
  it("suppresses log() in JSON mode but emits data()", () => {
    const out = new PassThrough();
    const o = new Output({ json: true, stdout: out });
    o.log("human readable");
    o.data({ ok: true });
    const chunks: Buffer[] = [];
    out.on("data", (c) => chunks.push(c));
    out.end();
    return new Promise<void>((resolve) => {
      out.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        expect(s).not.toContain("human readable");
        expect(s).toContain('"ok": true');
        resolve();
      });
    });
  });

  it("emits log() in text mode and skips data()", () => {
    const out = new PassThrough();
    const o = new Output({ json: false, stdout: out });
    o.log("hello");
    o.data({ ok: true });
    out.end();
    return new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      out.on("data", (c) => chunks.push(c));
      out.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        expect(s).toContain("hello");
        expect(s).not.toContain('"ok"');
        resolve();
      });
    });
  });
});
