import { describe, it, expect } from "vitest";
import { stripFrontmatter } from "./frontmatter.mjs";

describe("stripFrontmatter", () => {
  it("extracts tags and strips the frontmatter block", () => {
    const input = `---
type: Note
tags: [bdobb, help, widgets, news-ticker]
---

# News Ticker

Body text.`;
    const result = stripFrontmatter(input);
    expect(result.tags).toEqual(["bdobb", "help", "widgets", "news-ticker"]);
    expect(result.body).toBe("# News Ticker\n\nBody text.");
  });

  it("returns the markdown unchanged when there is no frontmatter", () => {
    const input = "# Just a page\n\nNo frontmatter here.";
    expect(stripFrontmatter(input)).toEqual({ tags: [], body: input });
  });
});
