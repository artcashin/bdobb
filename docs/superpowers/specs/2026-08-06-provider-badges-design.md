# Provider badges and provider filtering in the Widget Library

**Date:** 2026-08-06 · **Status:** Approved (Art, 2026-08-06)

## Goal

Every OpenBB widget is generated per provider (the hidden `provider` param;
the `source` field names it), but the Widget Library only whispers this in a
footer line. Make the provider a first-class citizen of the library: a colored
badge per card showing whether this deployment can actually use that provider,
and filtering so the library can be reduced to "widgets that will work for me."

## What ships

1. **Provider badge** on each Widget Library card, next to the existing type
   badge (`table`, `chart`, …): the provider name from `widget.source`, with a
   green background when the deployment has a working key (or the provider
   needs none), red when the key is required and missing, neutral gray while
   unknown. Cards with an empty `source` (builtins, key-maint's own widget)
   get no badge. The current `Source: …` footer line is removed — the badge
   replaces it.
2. **Provider filter**: a `<select>` beside the category chips — "All
   providers" plus one entry per provider present in the loaded widget set.
3. **"Only my authorized providers"** toggle chip: keeps only widgets whose
   provider is keyed or keyless. Composes with search, category, and the
   provider select.
4. **Rail collapses on open**: selecting Widget Library from the left rail
   returns the rail to its icon-width strip (`panel.close()` before
   `onOpenLibrary()`). Today the expanded rail — z-index 40 — stays painted
   over the library overlay (z-index 30) until the pointer happens to leave
   it; on touch it stays open indefinitely.

## Key state: `providerKeysStore`

A new zustand store, `src/stores/providerKeysStore.ts`, holding
`status[normalizedProvider] = "keyed" | "unkeyed" | "unknown"` plus a
`source: "key-maint" | "probe" | "none"` marker. Filled on startup and
refreshed when the backend list changes. Two sources, in preference order:

### Source 1 — key-maint (preferred)

If any configured backend's widgets.json contains the widget id
`provider_api_keys` (endpoint `keys`), that backend is a key-maint instance.
Fetch `GET /keys` through the normal dataClient path with that backend's auth
headers. The response is `{tier, rows}` with rows
`{provider, env_var, status: "set"|"empty"|"unknown", demo}`:

- `status: "set"` → **keyed** (demo keys count — they work, within limits)
- `status: "empty"` → **unkeyed**
- anything else → **unknown**
- **Alpaca pairing**: the registry lists `Alpaca` (`ALPACA_API_KEY`) and
  `Alpaca (secret)` (`ALPACA_API_SECRET`) as separate rows; alpaca is keyed
  only if **both** are `set`. The `(secret)` row itself maps to the same
  normalized provider and never appears as its own badge entry.

### Source 2 — live probes (fallback)

With no key-maint backend, probe at startup: for each distinct provider in
the loaded widget set, pick one of *that provider's own* widgets (so the
endpoint certainly supports the provider) — preferring one whose params all
carry default `value`s — and fire its endpoint once through dataClient with
those defaults:

- 2xx → **keyed**
- error body containing `Missing credential` → **unkeyed**
- anything else (timeout, HTTP 401/5xx, validation error) → **unknown** —
  never red, because the failure doesn't prove the key is absent

Probes run concurrently with a small cap (~4) and results are cached for the
app session. No persistent cache: keys change server-side, and startup is the
agreed refresh point.

### Keyless providers

Providers absent from key-maint's registry (yfinance, cboe, tmx, arcticdb,
kdb, federal_reserve, …) require no credential: **keyed** by definition. In
probe mode a 2xx gives the same answer directly.

### Name normalization

widgets.json says `Eodhd` / `Alpha_vantage`; key-maint says `EODHD` /
`Alpha Vantage`. Matching key: lowercase, strip every non-alphanumeric
character. A parenthetical suffix (`Alpaca (secret)`) is stripped before
normalizing and handled by the pairing rule above.

## UI details

- Badge is a sibling of `.widget-library-widget-type`, sharing its pill
  styling with three modifier classes (`keyed` green, `unkeyed` red,
  `unknown` neutral). Colors: the muted candlestick pair `#4caf7d` /
  `#d9695f` as badge backgrounds (with dark text for contrast), not the
  phosphor `--clock-green`, which is tuned to read as an LED. The pair is
  defined with the badge CSS itself so it exists in every snapshot
  (v3–v7 predate live-grid, where these values first appeared).
- Multi-source widgets (`source` arrays with several entries) are badged
  `Multisource` and take the best of their providers' statuses: green when
  at least one can serve the widget, red only when every one is known to be
  missing its key, neutral while any is unresolved. This matches how the
  provider filter and the authorized-only toggle already treat them, so the
  pill and the filters cannot contradict each other. The provider names are
  carried in the badge's title and screen-reader text.
  (Decided 2026-08-06, superseding "show the first source's badge".)
- The provider `<select>` and the authorized-only toggle live in the header
  next to the category chips and are keyboard-accessible (real `<select>`,
  real `<button aria-pressed>`).

## Testing

- **Store unit tests**: key-maint row parsing (set/empty/unknown/demo),
  alpaca pairing, keyless default, normalization pairs
  (`Eodhd`↔`EODHD`, `Alpha_vantage`↔`Alpha Vantage`), probe classification
  (2xx / missing-credential / other), probe widget selection (prefers
  defaulted params), session caching.
- **Component tests**: badge renders with the right modifier class per
  status; no badge when `source` is empty; provider select narrows the grid;
  authorized-only toggle hides unkeyed providers and keeps keyless ones;
  filters compose with search and category; LeftRail's Widget Library click
  collapses the rail (existing LeftRail.test.tsx gains the case).
- Hermetic: fetch and store mocked, same pattern as the dialog tests.

## Roll-up

Lands on main first, then folds into every tag v3.0.0–v9.0.0 (Art's call,
2026-08-06) with the established re-cut procedure: cherry-pick onto each
snapshot in a worktree, adapt per-snapshot Widget Library/test differences,
run that snapshot's full suite green, `commit-tree` replay preserving
messages/authors/dates, re-tag, force-push, dispatch installer rebuilds per
tag (never rely on multi-tag push events).

## Out of scope

- Editing keys from BDOBB (key-maint PUT is phase 2 server-side).
- Persistent probe caching or background re-probing.
- Any change to widget rendering or data fetching outside the library panel.
