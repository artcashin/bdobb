import { describe, it, expect, vi } from "vitest";
import { loadNav } from "./loadContent";

vi.mock("./generated/nav.json", () => ({
  default: { Widgets: [{ slug: "news-ticker", title: "News Ticker" }] },
}));

describe("loadNav", () => {
  it("returns the bundled nav tree", () => {
    expect(loadNav()).toEqual({ Widgets: [{ slug: "news-ticker", title: "News Ticker" }] });
  });
});
