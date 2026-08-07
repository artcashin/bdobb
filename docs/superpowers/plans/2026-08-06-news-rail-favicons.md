# News Rail Favicons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each News rail headline's source favicon (already resolved server-side, currently unused) next to its source name, fetched once per widget mount and never blocking the headline stream.

**Architecture:** `NewsRailRenderer` gains one more `useEffect` — a single, non-blocking `GET {base}/api/feeds?user=...` on mount, using the exact same auth pattern (`Authorization: Bearer` header) as the existing `seed()` call. The response is reduced to a `Map<number, string>` of `feed_id → favicon` held in state; each row looks itself up in that map and renders an `<img>` only when a favicon exists.

**Tech Stack:** React 18 + TypeScript, vitest + @testing-library/react (existing patterns in `NewsRailRenderer.tsx` / `NewsRailRenderer.test.tsx`).

**Spec:** `docs/superpowers/specs/2026-08-06-news-rail-favicons-design.md`

## Global Constraints

- Fetch `/api/feeds` **once on mount only** — no periodic refresh, no refetch on new articles arriving.
- The feeds fetch is **best-effort and non-fatal**: a failure (network error, non-OK response, an old backend with no `favicon` field) must leave headline seeding and the websocket stream completely unaffected. Log once with `logError`, prefixed `"news rail: "` to match the file's existing prefix convention (`"news rail: websocket open failed"`, `"news rail: openUrl failed"`) — do not retry, do not surface an error to the user.
- A feed with `favicon: null`, or a `feed_id` absent from the response entirely, renders **no icon** — never a broken-image placeholder.
- The icon is decorative: `alt=""`. The adjacent `.news-source` text already names the outlet; a screen reader must not announce it twice.
- **Effect ordering matters.** The existing seed/websocket `useEffect` (component lines 167–223) calls `fetchImpl` synchronously via `seed()` before its first `await`. Two existing tests read `fetchImpl.mock.calls[0]` and assume index 0 is the `/api/news` call. The new favicon effect **must be declared textually after** that existing effect (i.e. after its closing `}, [base, user, wsUrl, seed, merge]);` at line 223), so its fetch is recorded at `mock.calls[1]`, not `mock.calls[0]`. Getting this backwards silently breaks two passing tests with no code-level error.
- No server-side changes. No touching `/api/news`, `/api/feeds`, or rss-ticker.
- Only these files change: `src/components/renderers/NewsRailRenderer.tsx`, `src/components/renderers/NewsRailRenderer.test.tsx`, `src/styles.css`.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Favicon fetch, join, and render

**Files:**
- Modify: `src/components/renderers/NewsRailRenderer.tsx`
- Modify: `src/components/renderers/NewsRailRenderer.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: the component's existing `base` (`useMemo` from `normalizeBase(url)`, line 100), `user`, `token`, `fetchImpl` props — no new props added.
- Produces: nothing consumed by later work; this is the whole feature.

- [ ] **Step 1: Mock `logError`, and extend `okFetch()` to answer both endpoints**

Read `src/components/renderers/NewsRailRenderer.test.tsx` in full first (it is short). `../../lib/logger` is not currently mocked in this file — the component's two existing error paths (`websocket open failed`, `openUrl failed`) call the real `logError`, which is safe in jsdom (it's synchronous and swallows its own async failures) but means no test today can assert *that* a log happened. The new failure-path test needs to. Follow the file's own established idiom for mocking a single named export — it already does this for `openUrl` (lines 4–7):

```typescript
const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));
```

Add the same shape for `logError`, directly below it (still above the `@tauri-apps/plugin-http` mock at line 9):

```typescript
const logError = vi.fn();
vi.mock("../../lib/logger", () => ({
  logError: (...a: unknown[]) => logError(...a),
}));
```

And clear it alongside the existing `openUrl.mockClear()` in `beforeEach` (line 98):

```typescript
  beforeEach(() => {
    MockWebSocket.instances = [];
    openUrl.mockClear();
    logError.mockClear();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });
```

Now extend `okFetch()` to answer both endpoints. The current helper, lines 69–76:

```typescript
function okFetch(articles: NewsArticle[] = SEED) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ articles, next_cursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  ) as unknown as typeof fetch;
}
```

answers every call identically, regardless of URL. Every existing call site (`okFetch()`, `okFetch([...])`) passes at most one positional argument, so add a second, optional one and branch on the requested URL — this keeps every existing call site source-compatible:

```typescript
interface FeedFixture {
  id: number;
  favicon: string | null;
}

function okFetch(articles: NewsArticle[] = SEED, feeds: FeedFixture[] = []) {
  return vi.fn(async (url: string | URL) => {
    const body = String(url).includes("/api/feeds")
      ? { feeds }
      : { articles, next_cursor: null };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}
```

No other line in the test file needs to change for this step — every pre-existing `okFetch()` / `okFetch([...])` call now implicitly passes `feeds: []`, so the favicon effect (once it exists) will fetch, get `{ feeds: [] }`, and render no icons, which is exactly what today's tests already expect (none of them assert on favicons).

- [ ] **Step 2: Write the failing tests**

Add a new `describe` block at the end of the file, inside the existing top-level `describe("NewsRailRenderer", ...)` block (i.e. before its closing `});`):

```typescript
  describe("favicons", () => {
    it("fetches /api/feeds once on mount with the same auth header as the seed call", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: "data:image/x-icon;base64,AAA" }]);
      renderRail({ fetchImpl, token: "tkn-0123456789abcdef0123456789abcdef" });
      await screen.findByText("Second headline");

      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const feedsCall = calls.find(([u]) => String(u).includes("/api/feeds"));
      expect(feedsCall).toBeDefined();
      const [calledUrl, init] = feedsCall as [string, RequestInit];
      expect(calledUrl).toBe("https://openbb.example.ts.net:8088/api/feeds?user=art");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer tkn-0123456789abcdef0123456789abcdef"
      );
      // Called exactly once, matching the seed call's own single-call shape.
      expect(calls.filter(([u]) => String(u).includes("/api/feeds"))).toHaveLength(1);
    });

    it("renders the favicon next to the source for a feed that has one", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: "data:image/x-icon;base64,AAA" }]);
      renderRail({ fetchImpl });
      await screen.findByText("Second headline");
      // SEED's second article (id 1, "First headline") has feed_id: 1 (the
      // article() factory's default) and should get the icon.
      const row = screen.getByText("First headline").closest(".news-row")!;
      const img = row.querySelector(".news-favicon") as HTMLImageElement | null;
      expect(img).not.toBeNull();
      expect(img!.src).toBe("data:image/x-icon;base64,AAA");
      expect(img!.alt).toBe("");
    });

    it("renders no icon for a feed with a null favicon or an unlisted feed_id", async () => {
      const fetchImpl = okFetch(SEED, [{ id: 1, favicon: null }]); // feed_id 2 (SEED's other article) is absent entirely
      renderRail({ fetchImpl });
      await screen.findByText("Second headline");
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
    });

    it("stays fully functional when the feeds fetch fails, logging once and not throwing", async () => {
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/feeds")) throw new Error("network down");
        return new Response(JSON.stringify({ articles: SEED, next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      renderRail({ fetchImpl });
      // Headlines still work.
      expect(await screen.findByText("Second headline")).toBeInTheDocument();
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
      await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(logError.mock.calls[0][0]).toContain("favicon");
    });

    it("also logs once (and renders no icon) when the feeds endpoint returns a non-OK status", async () => {
      const fetchImpl = vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/feeds")) {
          return new Response("", { status: 500 });
        }
        return new Response(JSON.stringify({ articles: SEED, next_cursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;
      renderRail({ fetchImpl });
      expect(await screen.findByText("Second headline")).toBeInTheDocument();
      expect(document.querySelectorAll(".news-favicon")).toHaveLength(0);
      await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(logError.mock.calls[0][0]).toContain("500");
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run src/components/renderers/NewsRailRenderer.test.tsx`
Expected: the five new tests FAIL — no `.news-favicon` element exists yet, and no second fetch call is made. The pre-existing tests still PASS (Step 1's `okFetch` change is backward compatible).

- [ ] **Step 4: Implement the favicon fetch, state, and effect**

In `src/components/renderers/NewsRailRenderer.tsx`, add a type near the top of the file, after the existing `NewsArticle` interface (around line 33):

```typescript
interface FeedInfo {
  id: number;
  favicon: string | null;
}
```

Add state inside the component, alongside the existing `useState` calls (after line 103, `const [error, setError] = useState<string | null>(null);`):

```typescript
  // feed_id -> favicon data URI. Only entries with a real favicon are
  // stored, so "missing from the map" and "explicitly null" both read the
  // same way at render time: nothing to show.
  const [favicons, setFavicons] = useState<Map<number, string>>(new Map());
```

Add the new effect **immediately after** the existing seed/websocket effect's closing line — i.e. directly after line 223 (`}, [base, user, wsUrl, seed, merge]);`) and before line 225 (`const openArticle = ...`). This placement is required, not stylistic — see the Global Constraints note on effect ordering.

```typescript
  useEffect(() => {
    if (!base || !user) return;
    let cancelled = false;
    (async () => {
      const target = `${base}/api/feeds?user=${encodeURIComponent(user)}`;
      try {
        const res = await fetchImpl(target, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (cancelled) return;
        if (!res.ok) {
          // Best-effort: a favicon that never loads must not degrade the
          // headline stream, which is why this effect never touches `state`
          // — but a non-OK response is still worth one log line to diagnose.
          logError(`news rail: favicon fetch failed: HTTP ${res.status}`);
          return;
        }
        const body: unknown = await res.json().catch(() => null);
        const list = Array.isArray((body as { feeds?: unknown[] })?.feeds)
          ? ((body as { feeds: unknown[] }).feeds)
          : [];
        const map = new Map<number, string>();
        for (const f of list) {
          const feed = f as Partial<FeedInfo>;
          if (typeof feed.id === "number" && typeof feed.favicon === "string" && feed.favicon) {
            map.set(feed.id, feed.favicon);
          }
        }
        if (!cancelled) setFavicons(map);
      } catch (e) {
        // Transport failure: same non-fatal handling as a non-OK response.
        if (!cancelled) logError(`news rail: favicon fetch failed: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, user, token, fetchImpl]);
```

Change the row render (existing lines 259–275, inside `articles.map((a) => (...))`). The current row is:

```tsx
            <li
              key={a.id}
              className={`news-row${a.highlighted ? " highlighted" : ""}`}
              onDoubleClick={() => openArticle(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openArticle(a);
              }}
              tabIndex={0}
            >
              <span className="news-time">{rowTime(a)}</span>
              <span className="news-source">{a.source ?? ""}</span>
              <span className="news-title">{a.title}</span>
            </li>
```

Add the icon between `news-time` and `news-source`:

```tsx
            <li
              key={a.id}
              className={`news-row${a.highlighted ? " highlighted" : ""}`}
              onDoubleClick={() => openArticle(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter") openArticle(a);
              }}
              tabIndex={0}
            >
              <span className="news-time">{rowTime(a)}</span>
              {favicons.has(a.feed_id) && (
                <img className="news-favicon" src={favicons.get(a.feed_id)} alt="" />
              )}
              <span className="news-source">{a.source ?? ""}</span>
              <span className="news-title">{a.title}</span>
            </li>
```

- [ ] **Step 5: Add the CSS**

In `src/styles.css`, immediately after the existing `.news-time` rule (currently the line right before `.news-source`):

```css
.news-favicon {
  width: 14px; height: 14px; flex: none;
  border-radius: 2px; /* tidies up unusual/non-square favicons */
  object-fit: contain;
  /* .news-row aligns its children on the text baseline, which an <img> has
     none of (browsers fall back to its own bottom edge) — centering reads
     better next to the source text's x-height. */
  align-self: center;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run src/components/renderers/NewsRailRenderer.test.tsx`
Expected: PASS — all five new tests, and every pre-existing test in the file.

- [ ] **Step 7: Full verification and commit**

Run: `pnpm typecheck && pnpm test:run`
Expected: typecheck clean; full suite green, count at or above the pre-task baseline.

```bash
git add src/components/renderers/NewsRailRenderer.tsx src/components/renderers/NewsRailRenderer.test.tsx src/styles.css
git commit -m "feat: show each News rail headline's source favicon

rss-ticker already resolves and stores a favicon per feed, but only on
GET /api/feeds — /api/news (what the rail actually polls) carries just a
feed_id, by design, to avoid repeating a data URI on every headline. The
rail never took the second step of fetching /api/feeds and joining on it.

Fetches /api/feeds once on mount, using the same auth pattern as the
existing seed() call. Best-effort: a failed fetch logs once and leaves
headline seeding and the websocket stream untouched. A feed with no
resolved favicon renders no icon, never a broken-image placeholder.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Verification against the live backend

**Files:** none — manual verification, not a code task.

- [ ] **Step 1: Confirm against the real rss-ticker**

The unit tests are hermetic (injected `fetchImpl`, no network). Before calling this done, ask Art to open a dashboard with the News rail widget pointed at the real backend (`https://rss-feedhandler.tailb9874f.ts.net`, user `art`) and confirm: icons appear next to sources that have one resolved (7 of the 10 configured feeds, per the spec's live check), no icon (and no broken-image glyph) for Bloomberg/WSJ, and the rail's live streaming behavior is unchanged.
