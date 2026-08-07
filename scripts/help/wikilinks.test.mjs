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

  it("throws when the target slug isn't in this version's page set", () => {
    const known = new Set(["news-ticker"]);
    expect(() => rewriteWikilinks("See [[live-quotes]].", known)).toThrow(
      /Unresolved wikilink \[\[live-quotes\]\]/
    );
  });
});
