/** Returns the first H1's text — matches Tolaria's own title convention. */
export function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) throw new Error("No H1 title found in page.");
  return match[1].trim();
}
