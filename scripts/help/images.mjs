const IMAGE_RE = /!\[([^\]]*)\]\((\.{0,2}\/?attachments\/[^)]+)\)/g;

/**
 * Rewrites attachment-relative image paths (however deep the source page
 * sits — "../attachments/x.png" or "attachments/x.png") to the flat
 * ./assets/ layout the conversion step copies attachments into.
 */
export function rewriteImagePaths(markdown) {
  return markdown.replace(IMAGE_RE, (match, alt, path) => {
    const filename = path.split("/").pop();
    return `![${alt}](./assets/${filename})`;
  });
}
