import { describe, it, expect, vi } from "vitest";
import { loadNav, loadPage } from "./loadContent";

vi.mock("./generated/nav.json", () => ({
  default: { Widgets: [{ slug: "news-ticker", title: "News Ticker" }] },
}));

vi.mock("./generated/news-ticker.md?raw", () => ({
  default: "# News Ticker\n\nThe wire.",
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
