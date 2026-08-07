import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, relative, extname, basename } from "node:path";
import MiniSearch from "minisearch";
import { rewriteWikilinks } from "./wikilinks.mjs";
import { rewriteImagePaths } from "./images.mjs";
import { extractTitle } from "./title.mjs";
import { stripFrontmatter } from "./frontmatter.mjs";

function walkMarkdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "attachments" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (extname(entry) === ".md") {
      out.push(full);
    }
  }
  return out;
}

/**
 * Converts one bdobb-help version folder into the flat bundle the Help
 * window consumes: per-page markdown with wikilinks/images rewritten, a
 * nav tree grouped by source subfolder, and a MiniSearch index.
 */
export function convertVersionFolder(versionDir, outDir) {
  const slugOf = (filePath) => basename(filePath, ".md");
  // readdirSync's order isn't guaranteed and varies by filesystem (e.g.
  // macOS/APFS happens to return alphabetical order, but release builds run
  // on ubuntu-latest/ext4, which doesn't) -- sort explicitly so the sidebar
  // order and default landing page are deterministic across build
  // environments.
  const files = walkMarkdownFiles(versionDir).sort((a, b) => slugOf(a).localeCompare(slugOf(b)));
  const knownSlugs = new Set(files.map(slugOf));

  const pages = files.map((filePath) => {
    const raw = readFileSync(filePath, "utf8");
    const { tags, body } = stripFrontmatter(raw);
    const withLinks = rewriteWikilinks(body, knownSlugs);
    const withImages = rewriteImagePaths(withLinks);
    const title = extractTitle(withImages);
    const rel = relative(versionDir, filePath);
    const category = rel.includes("/") ? rel.split("/")[0] : null;
    return { slug: slugOf(filePath), title, tags, category, content: withImages };
  });

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "assets"), { recursive: true });

  const attachmentsDir = join(versionDir, "attachments");
  try {
    for (const file of readdirSync(attachmentsDir)) {
      copyFileSync(join(attachmentsDir, file), join(outDir, "assets", file));
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  for (const page of pages) {
    writeFileSync(join(outDir, `${page.slug}.md`), page.content, "utf8");
  }

  const categorized = pages
    .filter((p) => p.slug !== "home")
    .reduce((tree, p) => {
      const key = p.category ?? "General";
      (tree[key] ??= []).push({ slug: p.slug, title: p.title });
      return tree;
    }, {});

  // Sort category names and, within each, the pages by slug -- ties this to
  // the same deterministic ordering as `files` above rather than whatever
  // order categories were first encountered in.
  const nav = {};
  // "home" has no nav entry of its own (see the filter above), so without a
  // pinned entry it's only reachable via search and the app defaults to
  // whatever the alphabetically-first category's first page is instead of
  // the actual home/intro page. Pin it as the first sidebar entry.
  const homePage = pages.find((p) => p.slug === "home");
  if (homePage) {
    nav.Home = [{ slug: "home", title: homePage.title }];
  }
  for (const key of Object.keys(categorized).sort((a, b) => a.localeCompare(b))) {
    nav[key] = categorized[key].sort((a, b) => a.slug.localeCompare(b.slug));
  }
  writeFileSync(join(outDir, "nav.json"), JSON.stringify(nav, null, 2), "utf8");

  const miniSearch = new MiniSearch({
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
  miniSearch.addAll(
    pages.map((p) => ({
      id: p.slug,
      slug: p.slug,
      title: p.title,
      tags: p.tags.join(" "),
      content: p.content,
    }))
  );
  writeFileSync(join(outDir, "search-index.json"), JSON.stringify(miniSearch), "utf8");

  return pages;
}
