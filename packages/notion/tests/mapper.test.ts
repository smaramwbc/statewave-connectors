import { describe, it, expect } from "vitest";
import { classifyPage, defaultSubject, mapNotionEvent } from "../src/index.js";
import type { NotionPage } from "../src/index.js";

const newPage: NotionPage = {
  id: "page_abc",
  created_time: "2026-05-09T08:00:00.000Z",
  last_edited_time: "2026-05-09T08:00:00.000Z",
  archived: false,
  parent: { type: "database_id", database_id: "db_decisions" },
  url: "https://www.notion.so/Acme-Decisions-page_abc",
  title: "Decision: switch to typed connectors",
  body: "We will move all connectors to a typed package layout.",
};

const editedPage: NotionPage = {
  ...newPage,
  id: "page_xyz",
  last_edited_time: "2026-05-09T11:00:00.000Z",
  title: "Decision: pin Notion-Version 2022-06-28",
  body: "After review, we'll pin to the long-stable version.",
};

describe("notion mapper", () => {
  it("uses workspace:notion as the default subject", () => {
    expect(defaultSubject()).toBe("workspace:notion");
  });

  it("classifies a page with equal created/edited times as page.created", () => {
    const ev = classifyPage(newPage);
    expect(ev.type).toBe("page.created");
  });

  it("classifies a page with later edited time as page.updated", () => {
    const ev = classifyPage(editedPage);
    expect(ev.type).toBe("page.updated");
  });

  it("maps page.created to notion.page.created with title + body", () => {
    const ep = mapNotionEvent(classifyPage(newPage));
    expect(ep.subject).toBe("workspace:notion");
    expect(ep.kind).toBe("notion.page.created");
    expect(ep.text).toContain("created page");
    expect(ep.text).toContain("Decision: switch to typed connectors");
    expect(ep.text).toContain("We will move all connectors");
    expect(ep.source.type).toBe("notion.page.create");
    expect(ep.source.id).toBe("page:page_abc");
    expect(ep.source.url).toBe(newPage.url);
    expect(ep.metadata?.parent_type).toBe("database_id");
    expect(ep.metadata?.parent_id).toBe("db_decisions");
    expect(ep.occurred_at).toBe("2026-05-09T08:00:00.000Z");
  });

  it("maps page.updated to notion.page.updated with last_edited_time", () => {
    const ep = mapNotionEvent(classifyPage(editedPage));
    expect(ep.kind).toBe("notion.page.updated");
    expect(ep.source.type).toBe("notion.page.update");
    expect(ep.occurred_at).toBe("2026-05-09T11:00:00.000Z");
    expect(ep.text).toContain("updated page");
  });

  it("uses the custom subject when provided", () => {
    const ep = mapNotionEvent(classifyPage(newPage), { subject: "repo:acme/platform" });
    expect(ep.subject).toBe("repo:acme/platform");
  });

  it("renders an untitled page with a fallback title", () => {
    const blank: NotionPage = { ...newPage, title: "" };
    const ep = mapNotionEvent(classifyPage(blank));
    expect(ep.text).toContain("(untitled page)");
  });

  it("omits the body section when no body is set", () => {
    const noBody: NotionPage = { ...newPage, body: undefined };
    const ep = mapNotionEvent(classifyPage(noBody));
    expect(ep.text).not.toContain("\n\n");
    expect(ep.text).toContain('created page "Decision');
  });

  it("uses an editing-time-aware idempotency key so re-edits emit a new episode", () => {
    const a = mapNotionEvent(classifyPage(editedPage));
    const re = {
      ...editedPage,
      last_edited_time: "2026-05-09T12:00:00.000Z",
    };
    const b = mapNotionEvent(classifyPage(re));
    expect(a.idempotency_key).not.toEqual(b.idempotency_key);
  });

  it("captures workspace and page parents in metadata", () => {
    const workspaceTop: NotionPage = {
      ...newPage,
      parent: { type: "workspace", workspace: true },
    };
    const ep = mapNotionEvent(classifyPage(workspaceTop));
    expect(ep.metadata?.parent_type).toBe("workspace");
    expect(ep.metadata?.parent_id).toBeNull();

    const subPage: NotionPage = {
      ...newPage,
      parent: { type: "page_id", page_id: "page_parent" },
    };
    const ep2 = mapNotionEvent(classifyPage(subPage));
    expect(ep2.metadata?.parent_type).toBe("page_id");
    expect(ep2.metadata?.parent_id).toBe("page_parent");
  });
});
