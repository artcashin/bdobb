/**
 * Minimal frontmatter parser — only extracts what the conversion step
 * needs (the tags array), avoiding a YAML dependency for one field,
 * matching this repo's existing generate-capabilities.mjs style.
 */
export function stripFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { tags: [], body: markdown };
  const [, front, body] = match;
  const tagsLine = front.split("\n").find((l) => l.startsWith("tags:"));
  let tags = [];
  if (tagsLine) {
    const inner = tagsLine.slice(tagsLine.indexOf("[") + 1, tagsLine.indexOf("]"));
    tags = inner
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return { tags, body: body.trim() };
}
