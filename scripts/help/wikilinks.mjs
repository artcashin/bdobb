// The separator allows an optional leading backslash: inside a GFM table
// cell, a literal "|" must be written "\|" so it isn't parsed as a column
// break, so [[slug\|text]] is exactly as valid a wikilink as [[slug|text]].
const WIKILINK_RE = /\[\[([a-zA-Z0-9_-]+)(?:\\?\|([^\]]+))?\]\]/g;

/**
 * Rewrites Tolaria [[slug]] / [[slug|text]] wikilinks to standard markdown
 * links against an internal help:// scheme, which the Help window's link
 * handler intercepts for in-app navigation. Throws on any slug not present
 * in this version folder's page set — this is what catches a page that
 * still references a feature removed from an earlier (backward-stripped)
 * version snapshot.
 */
export function rewriteWikilinks(markdown, knownSlugs) {
  return markdown.replace(WIKILINK_RE, (match, slug, text) => {
    if (!knownSlugs.has(slug)) {
      throw new Error(
        `Unresolved wikilink [[${slug}]] — no page with that slug in this version folder.`
      );
    }
    const label = text ?? slug;
    return `[${label}](help://${slug})`;
  });
}
