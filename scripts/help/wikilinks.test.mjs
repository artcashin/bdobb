import { describe, it, expect } from "vitest";
import { rewriteWikilinks } from "./wikilinks.mjs";

describe("rewriteWikilinks", () => {
  it("rewrites a plain wikilink to a help:// link using the slug as label", () => {
    const known = new Set(["news-ticker"]);
    expect(rewriteWikilinks("See [[news-ticker]] for details.", known)).toBe(
      "See [news-ticker](help://news-ticker) for details."
    );
  });

  it("rewrites a piped wikilink using the custom display text", () => {
    const known = new Set(["news-ticker"]);
    expect(rewriteWikilinks("See [[news-ticker|News Ticker]] for details.", known)).toBe(
      "See [News Ticker](help://news-ticker) for details."
    );
  });

  it("rewrites a piped wikilink whose pipe is backslash-escaped (GFM table cell syntax)", () => {
    // Inside a Markdown table cell a literal "|" must be written "\|" so it
    // isn't parsed as a column separator -- real content (e.g.
    // backends-and-connections.md) writes wikilinks this way inside tables.
    const known = new Set(["news-ticker"]);
    expect(rewriteWikilinks("| [[news-ticker\\|News ticker]] | row |", known)).toBe(
      "| [News ticker](help://news-ticker) | row |"
    );
  });

  it("throws when the target slug isn't in this version's page set", () => {
    const known = new Set(["news-ticker"]);
    expect(() => rewriteWikilinks("See [[live-quotes]].", known)).toThrow(
      /Unresolved wikilink \[\[live-quotes\]\]/
    );
  });
});
