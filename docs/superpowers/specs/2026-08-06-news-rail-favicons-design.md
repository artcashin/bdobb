# News rail favicons

**Date:** 2026-08-06 · **Status:** Approved (Art, 2026-08-06)

## Goal

Each News rail headline shows its source as plain text (`WSJ Markets`). The
rss-ticker backend already resolves and stores a favicon per feed — it just
lives on a different endpoint than the one the rail polls. Show that icon
next to the source name.

## Root cause (not a regression)

`GET /api/news` (what `NewsRailRenderer` calls to seed and stream headlines)
returns each article with a `feed_id` but no icon — by design, per
`rss_ticker/broadcast.py`'s own comment: the icon lives once per feed in
`GET /api/feeds`, not repeated as a data URI on every headline. The renderer
already parses `feed_id` off every article and never takes the second step
of fetching `/api/feeds` and joining on it. No favicon code ever existed
client-side; this is new work, not a bug fix.

Verified against the live backend: `GET /api/feeds?user=art` returns a
`favicon` field per feed as a `data:image/x-icon;base64,...` URI, resolved
for 7 of the user's 10 configured feeds today (Bloomberg and WSJ have none —
a separate, smaller gap, out of scope here).

## What ships

1. **One fetch on mount.** `NewsRailRenderer` calls
   `GET {base}/api/feeds?user=...` once when the rail mounts, using the exact
   auth pattern the existing `seed()` call already uses (token as
   `Authorization: Bearer` when present; `fetchImpl` injected the same way).
   Not refreshed periodically (Art's call, 2026-08-06) — favicons rarely
   change once resolved, and a full dashboard reload is enough to pick up
   one that resolves later.
2. **A `feed_id → favicon` map** built from that response, held in renderer
   state.
3. **An icon before the source name** on each row:
   `[icon] WSJ Markets · headline`. A feed with no resolved favicon (`null`
   in the response) renders no icon — never a broken-image placeholder.
4. **Best-effort, non-fatal.** If the feeds fetch fails, times out, or the
   backend is old enough to not carry `favicon` at all, the rail must keep
   working exactly as it does today — headlines and the websocket stream are
   untouched. Log once with the existing `logError` helper; no retry, no
   error state shown to the user. This is a layer on top of the existing
   article stream, not a new hard dependency the rail can fail on.

## Interfaces touched

`src/components/renderers/NewsRailRenderer.tsx`:

- New (module-scope) types:
  ```typescript
  interface FeedInfo {
    id: number;
    favicon: string | null;
  }
  ```
- New state: `const [favicons, setFavicons] = useState<Map<number, string>>(new Map())`
  — only entries with a non-null favicon are stored, so a lookup miss and an
  explicit "no icon" both read as "nothing to render," with no extra branch.
- New effect, alongside the existing seed/websocket effects, firing once per
  mount (dependencies: `base`, `user`, `token`, `fetchImpl` — matching the
  existing `seed` callback's dependency list, since it hits the same
  parameters):
  ```typescript
  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    (async () => {
      try {
        const target = `${base}/api/feeds?user=${encodeURIComponent(user)}`;
        const res = await fetchImpl(target, {
          headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { feeds?: FeedInfo[] };
        const map = new Map<number, string>();
        for (const f of body.feeds ?? []) {
          if (f.favicon) map.set(f.id, f.favicon);
        }
        if (!cancelled) setFavicons(map);
      } catch (e) {
        if (!cancelled) logError(`NewsRailRenderer: favicon fetch failed: ${String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [base, user, token, fetchImpl]);
  ```
  The `cancelled` guard matches the pattern a mount/unmount race needs in
  this file; not doing it risks a `setState` after unmount if the widget is
  removed from the dashboard mid-fetch.
- Row render (`news-row` `<li>`, currently `news-time` / `news-source` /
  `news-title` spans) gains a fourth, conditional span immediately before
  `news-source`:
  ```tsx
  {favicons.get(a.feed_id) && (
    <img className="news-favicon" src={favicons.get(a.feed_id)} alt="" />
  )}
  ```
  `alt=""`: the adjacent `news-source` text already names the outlet, so the
  icon is decorative and must not be announced twice to a screen reader.

`src/styles.css`, alongside the existing `.news-source` rule:

```css
.news-favicon {
  width: 14px; height: 14px; flex: none;
  border-radius: 2px; /* tidies up unusual/non-square favicons */
  object-fit: contain;
}
```

Sized to the source text's line-height so the row's vertical rhythm doesn't
change.

## Testing

Following `NewsRailRenderer.test.tsx`'s existing `fetchImpl`-injection
pattern (its `okFetch()` helper currently answers only `/api/news` /
`/ws/news`-shaped calls and must be extended to also answer `/api/feeds`):

- the feeds fetch fires once on mount, with the same auth header as the seed
  call when a token is configured
- a row whose feed has a resolved favicon renders the `<img>` with the
  correct `src`
- a row whose feed has `favicon: null` (or an unknown `feed_id`) renders no
  icon
- a failed feeds fetch (network error, or a non-OK response) leaves the rail
  fully functional — headlines still render, no icon anywhere, exactly one
  `logError` call, no thrown error
- the icon's `alt` is empty (decorative, not a duplicate announcement)

## Out of scope

- Bloomberg and WSJ having no resolved favicon server-side — a separate,
  smaller rss-ticker-side gap.
- Periodic re-fetching of `/api/feeds` after mount.
- Any change to `/api/news`, `/api/feeds`, or rss-ticker's favicon
  resolution — this is a client-only change against the existing API.
