# BDOBB — Better Desktop for OpenBB

A Tauri 2 desktop app for self-hosted OpenBB stacks — the frontend of the
**Adventures in OpenBB** series. Each tagged release is the companion code for
one episode: check out the tag, follow that episode's "For the tinkerers"
section, and the app has exactly that chapter's functionality.

| Release | Episode | What it adds |
|---|---|---|
| v3.0.0 | Ep. 3 — I Asked for Electron and Got Talked Out of It | The app: hover rail, dashboard grid, widget renderers, built-ins (Note, Clock, Website), key status widget, backends & settings |
| v4.0.0 | Ep. 4 — Same Blueprint, Two Builders | The review & reconciliation layer: hardened tests, a11y, CSP, region error boundaries |

## What you get (this release: v4.0.0)

- **Dashboard grid** — drag, resize, remove widget cards; multiple dashboards
  in a tab strip; everything persists as plain JSON files you can back up.
- **Widget system** — discovery from any `widgets.json` backend (Episode 1's
  stack, or any OpenBB-protocol backend); renderers for tables (sortable,
  type-aware formatting), interactive Plotly charts, markdown, HTML, PDFs,
  metrics, and a raw-JSON fallback that means malformed data never blanks a
  card. Per-card parameters generated from the widget definition.
- **Built-in widgets** that need no backend at all: **Note** (markdown),
  **Clock** (market hours across venues, LED typeface), **Website** (frame a
  page — with an honest in-card explanation when a site refuses framing).
- **Hover panels** — an icon-width left rail and overlay panels that get out
  of the way; the dashboard never reflows.
- **Backends & settings** — add/edit backends with connection status; a
  rotating app log viewable in Settings.

**New in v4.0.0 (Ep. 4):** the adversarial-review layer, shipped as its own
diffable release — a strict Content-Security-Policy, error boundaries around
every top-level pane and dialog (a render throw degrades to one error card,
never a dead app), a startup banner naming exactly which loaders failed, and
the review-era regression suites (layout-write suppression, real-mount
persistence, per-boundary containment). Diff v3.0.0..v4.0.0 to see precisely
what adversarial review caught.

## Quick start

```bash
git clone https://github.com/artcashin/bdobb
cd bdobb
cp .env.example .env.local      # point VITE_OPENBB_API_URL at your backend
pnpm install
pnpm tauri dev                  # the desktop window (pnpm dev for frontend only)
```

Prereqs: Node 22+ with pnpm (`corepack enable pnpm`) and the Rust toolchain.

The Tauri capability file is **generated** from
`src-tauri/capability.template.json` by `scripts/generate-capabilities.mjs`
(run automatically by dev/build) — edit the template, never the generated
`default.json`. The HTTP scope is open to any http(s) host: BDOBB is a
generic front end, and which backends it talks to is configured at runtime
in the app, not compiled in. The generator's job is the machine-local part —
extra fs scope entries for `VITE_SHARE_FOLDERS`.

## Build

```bash
pnpm tauri build                       # this machine (macOS/Windows)
pnpm linux:deps && pnpm linux:build    # Linux x86_64 or arm64
```

Tagging `v*` builds macOS (Apple Silicon + Intel), Windows x64, and Linux
(x86_64 + arm64) and opens a draft release. Everything is unsigned: first
launch is right-click-Open on macOS, "More info → Run anyway" on Windows.
See [docs/building.md](docs/building.md).

## Testing

```bash
pnpm test:run      # unit + component suites (no live services needed)
pnpm typecheck
```

## Configuration files

Settings persist in `$APPDATA` (on macOS,
`~/Library/Application Support/com.artcashin.bdobb/`): `settings.json`,
`backends.json`, `dashboards/` (one JSON file per dashboard — back up freely),
`logs/bdobb.log`.

## Feedback

Bug reports go to [GitHub Issues](https://github.com/artcashin/bdobb/issues).
Enhancement requests and feature ideas go to
[BDOBB on Canny](https://artcashin.canny.io/bdobb) — search first and upvote
an existing idea if it's already there; post a new request when yours is
genuinely new.

## License

MIT. The Clock widget's typeface (Erbos Draco NBP, CC BY-SA 3.0) is bundled —
attribution in `src/assets/fonts/`.
