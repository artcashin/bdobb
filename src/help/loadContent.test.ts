import { describe, it, expect, vi } from "vitest";
import { loadNav, loadPage, loadSearchIndex, loadAssetUrl } from "./loadContent";

// KNOWN LIMITATION (see .superpowers/sdd/task-22-report.md): vi.mock only
// substitutes a module's content once Vite can resolve the import path to a
// real file. If src/help/generated/ is entirely absent (rather than just
// missing this one file), loadContent.ts's static imports of nav.json and
// search-index.json fail to resolve before any vi.mock factory gets a
// chance to run -- confirmed by testing with the whole directory renamed
// away. loadPage/loadAssetUrl below have the same gap for a different
// reason: they read from import.meta.glob(...) results, which enumerate
// real files on disk at transform time, so no vi.mock can inject an entry
// for a file that was never enumerated. None of this is fixable from this
// test file alone; it needs either a pretest fixture step or a Vite
// resolveId hook (see Vitest's "Mocking Modules" guide, "non-existent
// modules"). This file's tests only prove correctness when
// src/help/generated/ exists on disk (any content -- the mocks below
// override it), matching every environment except a checkout that hasn't
// run `pnpm dev`/`pnpm build` yet.
//
// vi.mock factories are hoisted above other code in this file, so a factory
// can't directly reference a module-scope variable declared normally.
// vi.hoisted computes the fixture first so the factory below can use it.
const searchIndexFixture = vi.hoisted(() => {
  // Build a real, tiny MiniSearch instance so the serialized shape below is
  // guaranteed valid — hand-writing MiniSearch's internal index format would
  // be fragile and opaque to maintain.
  const { createRequire } = require("node:module");
  const require_ = createRequire(import.meta.url);
  const MiniSearch = require_("minisearch");
  const index = new MiniSearch({
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
  index.addAll([
    { id: "news-ticker", title: "News Ticker", tags: ["widgets"], content: "The wire." },
  ]);
  return JSON.parse(JSON.stringify(index));
});

vi.mock("./generated/search-index.json", () => ({
  default: searchIndexFixture,
}));

vi.mock("./generated/nav.json", () => ({
  default: { Widgets: [{ slug: "news-ticker", title: "News Ticker" }] },
}));

vi.mock("./generated/news-ticker.md?raw", () => ({
  default: "# News Ticker\n\nThe wire.",
}));

vi.mock("./generated/assets/example.png?url", () => ({
  default: "/mocked-asset-url/example.png",
}));

describe("loadNav", () => {
  it("returns the bundled nav tree", () => {
    expect(loadNav()).toEqual({ Widgets: [{ slug: "news-ticker", title: "News Ticker" }] });
  });
});

describe("loadPage", () => {
  it("returns the bundled markdown for a given slug", () => {
    expect(loadPage("news-ticker")).toBe("# News Ticker\n\nThe wire.");
  });
});

describe("loadSearchIndex", () => {
  it("returns a MiniSearch instance that can search bundled pages", () => {
    const index = loadSearchIndex();
    expect(typeof index.search).toBe("function");
  });
});

describe("loadAssetUrl", () => {
  it("resolves a bundled asset's filename to its real served URL", () => {
    expect(loadAssetUrl("example.png")).toBe("/mocked-asset-url/example.png");
  });

  it("throws a clear error for an asset that isn't bundled", () => {
    expect(() => loadAssetUrl("does-not-exist.png")).toThrow(/no bundled help asset/i);
  });
});
