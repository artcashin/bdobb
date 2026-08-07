import navData from "./generated/nav.json";

export type NavTree = Record<string, Array<{ slug: string; title: string }>>;

/** Reads the version-specific nav tree bundled by scripts/fetch-help-content.mjs. */
export function loadNav(): NavTree {
  return navData as NavTree;
}
