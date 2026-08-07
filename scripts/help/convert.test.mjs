import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
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

  it("pins a Home entry as the first nav category, linking to the home slug", () => {
    const nav = JSON.parse(readFileSync(join(outDir, "nav.json"), "utf8"));
    expect(Object.keys(nav)[0]).toBe("Home");
    expect(nav.Home).toEqual([{ slug: "home", title: "Sample Help" }]);
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

describe("convertVersionFolder nav ordering", () => {
  // readdirSync's order isn't guaranteed and varies by filesystem/platform
  // (macOS/APFS happens to return alphabetical order; ubuntu-latest/ext4,
  // where release builds run, doesn't). This creates files across
  // categories deliberately out of alphabetical order to prove the nav is
  // sorted explicitly rather than relying on directory enumeration order.
  let tmp;
  let outDir;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "bdobb-help-order-test-"));
    mkdirSync(join(tmp, "Zeta"), { recursive: true });
    mkdirSync(join(tmp, "Alpha"), { recursive: true });
    writeFileSync(join(tmp, "Zeta", "b-page.md"), "# B Page\n");
    writeFileSync(join(tmp, "Zeta", "a-page.md"), "# A Page\n");
    writeFileSync(join(tmp, "Alpha", "z-page.md"), "# Z Page\n");

    outDir = mkdtempSync(join(tmpdir(), "bdobb-help-order-out-"));
    convertVersionFolder(tmp, outDir);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it("orders nav categories alphabetically", () => {
    const nav = JSON.parse(readFileSync(join(outDir, "nav.json"), "utf8"));
    expect(Object.keys(nav)).toEqual(["Alpha", "Zeta"]);
  });

  it("orders pages within a category alphabetically by slug", () => {
    const nav = JSON.parse(readFileSync(join(outDir, "nav.json"), "utf8"));
    expect(nav.Zeta.map((p) => p.slug)).toEqual(["a-page", "b-page"]);
  });
});
