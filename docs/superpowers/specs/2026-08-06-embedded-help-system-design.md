# Embedded Help System — native Help window + version-scoped content pipeline

**Date:** 2026-08-06 · **Status:** Approved (Art, 2026-08-06)

Spans two repos: **bdobb** (the Help menu, window, and build pipeline) and
**bdobb-help** (new — the content, staged and reviewed as a Tolaria vault).
Neither half is useful without the other.

## Goal

BDOBB has no in-app documentation. A 22-page help system already exists as a
Tolaria vault (`~/Tolaria/BDOBB Help/`), written by topic (Getting Started,
Interface, Widgets, Configuration, Integrations, iPad App, Troubleshooting)
and cross-linked with Tolaria wikilinks. This spec embeds that content into
BDOBB itself: a native **Help** menu opens a dedicated window with a
searchable, browsable copy of the docs matching the exact version installed —
not a generic doc site, a versioned one, since v3.0.0's BDOBB has no AI chat
or news ticker and its help shouldn't claim otherwise.

## Scope

**In scope this session:**
- The `bdobb-help` content repo, seeded from the existing Tolaria vault,
  restructured into full-snapshot version folders (`v3.0.0/` … `v9.0.0/`).
- The fetch → convert → bundle pipeline in bdobb.
- The native Help menu, the Help window, and its React app (nav + content +
  search).
- Validated against current `HEAD` only (pulls `v9.0.0/`, the newest folder).

**Explicitly out of scope (deferred):**
- Rolling this *code* feature into bdobb's actual `v3.0.0`–`v8.0.0` git tags
  via the repo's existing cherry-pick + `commit-tree` replay convention. That
  requires touching published release history and is its own project once
  this design is proven against HEAD.
- Everything past v9.0.0 (the planned real-time chart, ArcticDB explorer, the
  kdb+ cache) — those pages exist in the vault already, marked accordingly,
  and ship in v9.0.0's folder as "planned" content, same as they read today.

## Decisions taken (and rejected alternatives)

- **A separate native window, opened from a Help menu item — not a panel in
  the main window.** (Art's call.) Rejected a command-palette or right-pane
  tab: those compete with the main window's own screen-space budget, which is
  the exact thing BDOBB's whole layout philosophy (icon rail, folding AI
  pane) exists to protect. Docs are a reference surface, not a dashboard
  widget — a separate window lets someone keep help open on a second monitor
  while working the dashboard on the first.
- **Full-snapshot version folders in the content repo, not incremental
  diffs.** (Art's call, overriding the initial recommendation.) An
  incremental scheme (`v6/` holds only what's new since `v5/`) avoids
  duplicating unchanged pages, but full snapshots mirror exactly how bdobb's
  own git tags already work in this project — each version folder is
  reviewable as one coherent unit, matching the "stage and review a version"
  workflow the content will actually go through in Tolaria. The cost is
  explicit: changing a page that spans many versions means editing it in
  every folder where it appears.
- **`bdobb-help` is a new public repo**, not a `docs/help/` folder committed
  inside bdobb itself. Content is drafted and reviewed in Tolaria against
  this repo's git history; bdobb's build *pulls* from it rather than owning
  it directly. Public, matching `rss-ticker` and `openbb-eodhd` — no auth
  needed for release CI to clone it.
- **Exact version match required, hard error otherwise.** The fetch step
  looks for `bdobb-help/vX.Y.Z/` matching `package.json`'s `version` exactly.
  No fallback to "closest lower version" — a missing folder fails the build
  loudly instead of silently shipping the wrong version's docs (or last
  release's stale claims about features that didn't exist yet).
- **The Help window is its own frontend, not a mode of the main app.** No
  shared stores, no widget system — it never needs to talk to a backend.
  Keeps the CSP simple (no `connect-src` additions) and means a bug in the
  main dashboard can't take the help window down with it, or vice versa.

## Content repo — `bdobb-help`

### Layout

```
bdobb-help/
  v3.0.0/
    home.md
    Interface/layout-and-navigation.md
    Configuration/app-data-and-settings.md
    attachments/  (only the shots valid at v3: rail-hover.gif, rail-open.png, rail-closed.png, design-brainstorm-options.png)
  v4.0.0/          (identical to v3 — Ep. 4 is process narrative, not help content)
  v5.0.0/
    ...v4 content, plus:
    Getting Started/{installing-and-running,connecting-a-backend,importing-dashboards}.md
    Interface/dashboards-and-widgets.md
    attachments/  (adds the Ep.5 reference-backend/widget-library/grouping shots)
  v6.0.0/
    ...v5 content, plus:
    Widgets/ai-chat.md
    Integrations/rita-ai-agent-setup.md
    (the Rita/MCP entries in troubleshooting-*.md appear starting here)
  v7.0.0/
    ...v6 content, plus:
    iPad App/{installing-on-ipad,ipad-interface-differences}.md
  v8.0.0/
    ...v7 content, plus:
    Widgets/news-ticker.md
    Integrations/{rss-feed-sources,tailscale-networking}.md
    Configuration/secrets-and-access.md
  v9.0.0/
    ...v8 content, plus:
    Widgets/{live-quotes,real-time-chart,arcticdb-explorer}.md
    Integrations/eodhd-data-provider.md
    Configuration/kdb-cache.md
```

Every folder is a complete, independently valid vault snapshot: wikilinks
only ever point within the same folder, `troubleshooting-using-bdobb.md` /
`troubleshooting-infrastructure.md` only reference entries that exist in that
version, `home.md`'s table of contents only lists pages present at that
version, and `about-this-guide.md`'s episode table is trimmed to the episodes
that version's content actually draws from. Episode 4 content stays excluded
throughout, per the existing vault.

### What moves, what's generated

The existing 22-file vault becomes the seed for `v9.0.0/` (it already
reflects "everything through Ep. 9 plus the planned pages"). `v3.0.0/`
through `v8.0.0/` are built by taking `v9.0.0/` and removing pages/sections
that didn't exist yet, then fixing up wikilinks and troubleshooting entries
that reference removed pages. This is content work done once, by hand, in
Tolaria — not scripted, since "what did this paragraph look like before
feature X existed" isn't mechanically derivable from the final version.

## Conversion pipeline — bdobb side

### `scripts/fetch-help-content.mjs`

1. Read `version` from `package.json`.
2. Clone/pull `github.com/artcashin/bdobb-help` into a gitignored cache
   (`.help-cache/`).
3. Locate `.help-cache/vX.Y.Z/` matching the version exactly. Missing folder
   → hard error, build fails.
4. Run the conversion step (below) over that folder, writing output to a
   generated directory Vite bundles (e.g. `src/help/generated/`, gitignored).

Wired into `pnpm dev` and `pnpm build` the same way `generate-capabilities.mjs`
already is (`beforeDevCommand` / `beforeBuildCommand` chain in
`vite.config.ts` / `package.json` scripts). Release CI needs nothing extra
beyond outbound network access to a public repo, which GitHub Actions
runners already have.

### Conversion step

Per page:
- **Title** — first H1, matching Tolaria's own title convention.
- **Wikilinks** (`[[slug]]`, `[[slug|text]]`) — rewritten by a remark plugin
  to an internal `help://slug` scheme; the content pane's link handler
  intercepts these and navigates within the window instead of hitting the
  filesystem.
- **Images** — copied into the generated directory, paths rewritten to
  resolve from wherever Vite serves them.
- **Frontmatter** — `tags:` feed the search index; `type: Note` and other
  Tolaria-managed fields are dropped.

Across the whole folder:
- **Search index** — MiniSearch, built once at fetch time from every page's
  title + tags + body, serialized as a JSON asset. No runtime indexing cost;
  rebuilt only when content changes (i.e., on the next fetch/build).
- **Nav tree** — derived from the folder structure and `home.md`'s section
  ordering.

## App side — bdobb

### Native Help menu

New surface — bdobb has no native OS menu today (`src-tauri/src/*.rs` has no
`Menu`/`menu` usage). Added via Tauri v2's `tauri::menu` builder in `lib.rs`:
a top-level **Help** menu with one item ("BDOBB Help"), wired through
`.on_menu_event()`.

### The Help window

Second Vite entry point (`help.html` → `src/help/main.tsx`), independent of
the main app's stores and widget system. On menu click: `WebviewWindowBuilder`
creates the window if it doesn't exist yet, else focuses the existing one
(no duplicate windows from repeated clicks).

Layout: sidebar (nav tree + search box, MiniSearch-backed typeahead) + content
pane (`react-markdown` + `remark-gfm` + the `help://` link-resolving plugin).
Styled from BDOBB's existing CSS tokens (`styles.css`) rather than a fresh
design system — it should read as part of the same app, not a bolted-on doc
site.

No `connect-src` additions needed in the CSP — the window never talks to a
backend, tool server, or agent. All content is static, bundled at build time.

## Testing

- Fetch script: unit-testable with a fixture repo (or a fixture folder
  standing in for the clone target) — exact-version match succeeds, mismatch
  hard-errors, output directory matches expected shape.
- Conversion step: unit tests per transform (wikilink rewrite, image path
  rewrite, frontmatter stripping) against small fixture markdown files —
  cheap, deterministic, no network.
- Help window: component tests for nav rendering, search-then-navigate, and
  wikilink click-through, using a small fixture content set (not the real
  bundled content, to keep tests independent of `bdobb-help`'s state).
- **Known gap:** this session only ever runs the pipeline against `v9.0.0/`
  (current `HEAD`'s matching folder). The other six folders are validated by
  the conversion step's fixture tests and by manual review of their content
  in Tolaria, not by an actual bdobb build — that only happens when the
  deferred tag-rollout work (out of scope here) runs the same pipeline
  against each historical tag.

## Success criteria

- [ ] `bdobb-help` repo exists, public, pushed, with 7 version folders.
- [ ] `pnpm dev` and `pnpm build` fetch and bundle `v9.0.0/` content without
      manual steps.
- [ ] Help menu item opens a window; repeated clicks focus rather than
      duplicate it.
- [ ] Sidebar nav, search, and wikilink navigation all work against the
      bundled v9.0.0 content.
- [ ] A build against a `package.json` version with no matching folder fails
      the build, not silently.
- [ ] Fetch/conversion unit tests and Help-window component tests pass.
