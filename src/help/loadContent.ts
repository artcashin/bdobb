import MiniSearch, { type AsPlainObject } from "minisearch";
import navData from "./generated/nav.json";
import searchIndexData from "./generated/search-index.json";

export type NavTree = Record<string, Array<{ slug: string; title: string }>>;

/** Reads the version-specific nav tree bundled by scripts/fetch-help-content.mjs. */
export function loadNav(): NavTree {
  return navData as NavTree;
}

const pages = import.meta.glob("./generated/*.md", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Returns the bundled markdown for a page by slug, e.g. "news-ticker". */
export function loadPage(slug: string): string {
  const entry = pages[`./generated/${slug}.md`];
  if (!entry) throw new Error(`No bundled help page for slug "${slug}"`);
  return entry;
}

/** Rehydrates the search index bundled by scripts/fetch-help-content.mjs. */
export function loadSearchIndex(): MiniSearch {
  // resolveJsonModule infers an exact, narrow literal type from whatever
  // search-index.json happens to contain (its shape varies with the number
  // and content of bundled pages -- e.g. the tiny seed fixture vs. real
  // content), which doesn't structurally match MiniSearch's general
  // `AsPlainObject` type. The JSON is always produced by MiniSearch's own
  // `toJSON()` in scripts/help/convert.mjs, so it's a valid AsPlainObject at
  // runtime regardless of size; the cast just undoes TS's over-narrow
  // inference for a data import.
  return MiniSearch.loadJS(searchIndexData as unknown as AsPlainObject, {
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
}

const assets = import.meta.glob("./generated/assets/*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Resolves a bundled asset's filename (e.g. "news-window.png") to the URL Vite actually serves it at. */
export function loadAssetUrl(filename: string): string {
  const entry = assets[`./generated/assets/${filename}`];
  if (!entry) throw new Error(`No bundled help asset "${filename}"`);
  return entry;
}
