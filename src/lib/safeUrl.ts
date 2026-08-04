/**
 * URL scheme validation for values that reach the DOM.
 *
 * Two sinks take URLs the app did not author: citation hrefs come from Rita's
 * SSE stream, and iframe widget endpoints come from a backend's widgets.json.
 * Neither is under our control, and both land in an attribute the webview will
 * execute for `javascript:` — `<a href="javascript:...">` runs on click, and an
 * iframe `src` runs on load, sandbox notwithstanding, because the sandbox
 * governs what the framed document may do, not whether the scheme is honoured.
 *
 * `data:` is excluded for the same reason: a `data:text/html` document is
 * same-origin-ish enough in some webviews to be worth refusing outright, and no
 * legitimate citation or widget endpoint needs it.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * The URL if it is safe to place in an href/src, otherwise null.
 *
 * Parsing rather than string-matching is deliberate: `javascript:` survives
 * leading whitespace, embedded newlines and mixed case ("JaVaScRiPt:\n"), all
 * of which a startsWith check misses and the URL parser normalizes away.
 */
export function safeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Relative URLs have no scheme to abuse, but they also cannot be resolved
    // without a base — an iframe pointing at one would load the app itself.
    return null;
  }

  return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : null;
}

/** Whether a URL is safe to render as a link or frame. */
export function isSafeUrl(raw: unknown): boolean {
  return safeUrl(raw) !== null;
}

/**
 * Whether a string is an http(s) URL — narrower than {@link isSafeUrl}: also
 * excludes `mailto:`. For fields where the value must be a fetchable
 * endpoint (a backend base URL, an MCP server URL, the Rita URL) rather than
 * anything safe to place in a link or frame (Task 8 merge: ported from
 * desk's `url.ts`, added there so BackendsDialog and SettingsDialog share one
 * check instead of each re-deriving `new URL(...).protocol` locally).
 */
export function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
