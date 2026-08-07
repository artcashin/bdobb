import { describe, it, expect, vi } from "vitest";
import { loadNav, loadPage, loadSearchIndex, loadAssetUrl } from "./loadContent";

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
