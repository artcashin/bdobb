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
  const files = walkMarkdownFiles(versionDir);
  const slugOf = (filePath) => basename(filePath, ".md");
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

  const nav = pages
    .filter((p) => p.slug !== "home")
    .reduce((tree, p) => {
      const key = p.category ?? "General";
      (tree[key] ??= []).push({ slug: p.slug, title: p.title });
      return tree;
    }, {});
  writeFileSync(join(outDir, "nav.json"), JSON.stringify(nav, null, 2), "utf8");

  const miniSearch = new MiniSearch({
    fields: ["title", "tags", "content"],
    storeFields: ["title", "slug"],
  });
  miniSearch.addAll(
    pages.map((p) => ({
      id: p.slug,
      title: p.title,
      tags: p.tags.join(" "),
      content: p.content,
    }))
  );
  writeFileSync(join(outDir, "search-index.json"), JSON.stringify(miniSearch), "utf8");

  return pages;
}
