import MiniSearch from "minisearch";
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
  return MiniSearch.loadJS(searchIndexData, {
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
