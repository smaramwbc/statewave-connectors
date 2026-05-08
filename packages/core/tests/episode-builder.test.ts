import { describe, it, expect } from "vitest";
import { EpisodeBuilder, ConnectorError } from "../src/index.js";

describe("EpisodeBuilder", () => {
  it("builds a normalized episode with derived idempotency key and occurred_at", () => {
    const b = new EpisodeBuilder();
    const ep = b.build({
      subject: "repo:acme/widgets",
      kind: "github.issue.opened",
      text: "Investigate flaky CI",
      occurred_at: "2026-01-02T03:04:05Z",
      source: { type: "github", id: "issue-1", url: "https://github.com/acme/widgets/issues/1" },
    });
    expect(ep.subject).toBe("repo:acme/widgets");
    expect(ep.kind).toBe("github.issue.opened");
    expect(ep.text).toBe("Investigate flaky CI");
    expect(ep.occurred_at).toBe("2026-01-02T03:04:05.000Z");
    expect(ep.source.type).toBe("github");
    expect(ep.idempotency_key).toMatch(/^[a-f0-9]{32}$/);
  });

  it("merges builder defaults into metadata", () => {
    const b = new EpisodeBuilder({ metadata: { repo: "acme/widgets" } });
    const ep = b.build({
      subject: "repo:acme/widgets",
      kind: "github.issue.comment",
      text: "looks good",
      source: { type: "github", id: "c-1" },
      metadata: { author: "ada" },
    });
    expect(ep.metadata).toEqual({ repo: "acme/widgets", author: "ada" });
  });

  it("uses provided idempotency_key verbatim", () => {
    const b = new EpisodeBuilder();
    const ep = b.build({
      subject: "repo:acme/widgets",
      kind: "github.release.published",
      text: "v1",
      source: { type: "github", id: "rel-1" },
      idempotency_key: "fixed-key",
    });
    expect(ep.idempotency_key).toBe("fixed-key");
  });

  it("rejects missing subject/kind/source", () => {
    const b = new EpisodeBuilder();
    expect(() =>
      b.build({ subject: "", kind: "x", text: "", source: { type: "t", id: "i" } }),
    ).toThrow(ConnectorError);
    expect(() =>
      b.build({ subject: "s", kind: "", text: "", source: { type: "t", id: "i" } }),
    ).toThrow(ConnectorError);
    expect(() =>
      // @ts-expect-error testing runtime guard
      b.build({ subject: "s", kind: "k", text: "", source: { type: "", id: "" } }),
    ).toThrow(ConnectorError);
  });

  it("produces stable idempotency keys for equivalent inputs", () => {
    const b = new EpisodeBuilder();
    const a = b.build({
      subject: "repo:a/b",
      kind: "github.issue.opened",
      text: "x",
      occurred_at: "2026-01-01T00:00:00Z",
      source: { type: "github", id: "issue-7" },
    });
    const c = b.build({
      subject: "repo:a/b",
      kind: "github.issue.opened",
      text: "different body",
      occurred_at: "2026-01-01T00:00:00Z",
      source: { type: "github", id: "issue-7" },
    });
    expect(a.idempotency_key).toBe(c.idempotency_key);
  });
});
