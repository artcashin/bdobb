import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { convertVersionFolder } from "./convert.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "__fixtures__/sample-version");

describe("convertVersionFolder", () => {
  let outDir;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "bdobb-help-convert-test-"));
    convertVersionFolder(fixtureDir, outDir);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a converted page per markdown file", () => {
    expect(existsSync(join(outDir, "home.md"))).toBe(true);
    expect(existsSync(join(outDir, "news-ticker.md"))).toBe(true);
  });

  it("rewrites the wikilink and image path in the converted content", () => {
    const content = readFileSync(join(outDir, "home.md"), "utf8");
    expect(content).toContain("[News Ticker](help://news-ticker)");

    const ticker = readFileSync(join(outDir, "news-ticker.md"), "utf8");
    expect(ticker).toContain("![a shot](./assets/example.png)");
  });

  it("copies attachments into assets/", () => {
    expect(existsSync(join(outDir, "assets/example.png"))).toBe(true);
  });

  it("writes a nav tree grouping pages by their source folder", () => {
    const nav = JSON.parse(readFileSync(join(outDir, "nav.json"), "utf8"));
    expect(nav.Widgets).toEqual([{ slug: "news-ticker", title: "News Ticker" }]);
  });

  it("writes a search index covering every page", () => {
    const index = JSON.parse(readFileSync(join(outDir, "search-index.json"), "utf8"));
    expect(index).toBeTruthy();
  });

  it("stores the slug on each search index entry so results are navigable", () => {
    // storeFields is ["title", "slug"] (see loadContent.ts's loadSearchIndex),
    // so every indexed doc must carry a "slug" property -- otherwise
    // MiniSearch.storeFields silently stores `undefined` and HelpSearch's
    // onSelect(result.slug) navigates nowhere.
    const index = JSON.parse(readFileSync(join(outDir, "search-index.json"), "utf8"));
    const stored = Object.values(index.storedFields);
    expect(stored.length).toBeGreaterThan(0);
    for (const doc of stored) {
      expect(doc.slug).toBeTruthy();
    }
  });
});
