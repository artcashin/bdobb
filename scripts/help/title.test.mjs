import { describe, it, expect } from "vitest";
import { extractTitle } from "./title.mjs";

describe("extractTitle", () => {
  it("extracts the first H1", () => {
    expect(extractTitle("# News Ticker\n\nSome body text.")).toBe("News Ticker");
  });

  it("throws when there's no H1", () => {
    expect(() => extractTitle("Just a paragraph, no heading.")).toThrow(
      /No H1 title found/
    );
  });
});
