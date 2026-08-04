# BDOBB — Better Desktop for OpenBB

A Tauri 2 desktop app for self-hosted OpenBB stacks — the frontend of the
**Adventures in OpenBB** series. Each tagged release is the companion code for
one episode: check out the tag, follow that episode's "For the tinkerers"
section, and the app has exactly that chapter's functionality.

| Release | Episode | What it adds |
|---|---|---|
| v3.0.0 | Ep. 3 — I Asked for Electron and Got Talked Out of It | The app: hover rail, dashboard grid, widget renderers, built-ins (Note, Clock, Website), key status widget, backends & settings |
| v4.0.0 | Ep. 4 — Same Blueprint, Two Builders | The review & reconciliation layer: hardened tests, a11y, CSP, region error boundaries |
| v5.0.0 | Ep. 5 — Kick the Tires in Ten Minutes | One-command reference backend, conformance suite, Workspace apps.json import/export + parameter groups |
| v6.0.0 | Ep. 6 — The Analyst Who Never Leaves the Building | The chat pane: agent protocol client, SSE streaming, MCP tools, dashboard context |
| v7.0.0 | Ep. 7 — The iPadOS Adventure | iPadOS builds, touch input, free-tier signing flow |
| v8.0.0 | Ep. 8 — The Tape Comes to the Closet | live_grid renderer: streaming quotes in your own app |

## What you get (this release: v9.0.0)

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

**New in v9.0.0 (Ep. 9):** the wire, natively. A **News rail** built-in
widget that speaks an [rss-ticker](https://github.com/artcashin/rss-ticker)
backend's protocol directly — REST seed plus websocket stream, no iframe.
Point it at the ticker's URL and user id: under `tailscale_auth` your
Tailscale identity is the whole credential (the token field stays blank and
no secret exists anywhere); in token mode the REST call carries the token as
an `Authorization` header so it never appears in a URL BDOBB controls (the
websocket, which cannot carry headers, is the documented exception). Live
frames prepend and dedupe by id, every reconnect re-seeds (which doubles as
gap-fill), a 4401 close is terminal ("unauthorized", no retry storm),
highlighted headlines take the accent color, and double-click/Enter opens
the story in your browser — `http(s)` links only.

**New in v8.0.0 (Ep. 8):** prices that move. The **live_grid renderer**:
point BDOBB at the companion stack's `live-grid` service (Ep. 8 of the
series) and a watchlist of US equities, crypto and forex updates in place —
seeded by a normal GET, then streamed over a WebSocket to the widget's
`wsEndpoint`, rows matched by `wsRowIdColumn`. Updated cells flash (green
up-ticks, red down-ticks; columns can opt out via `enableCellChangeWs:
false`), signed columns color by `greenRed`/`showCellChange` render
functions, and a status dot says whether the stream is live or re-dialing.
The socket re-sends `{"params": …}` on every parameter change, so editing
the symbol list retunes the backend's upstream subscriptions without a
reconnect. Same origin-pinning as every other endpoint: nothing in
widgets.json can point the socket at a different host.

**New in v7.0.0 (Ep. 7):** BDOBB on an **iPad**. `pnpm ios:check/init/dev/build`
with a preflight that names each missing toolchain piece; free-Apple-ID
signing flow (`pnpm ios:team` + `APPLE_DEVELOPMENT_TEAM` in `.env.local` —
never committed); and a second input paradigm chosen at runtime: with a
trackpad/Magic Keyboard the hover panels behave exactly as on desktop, by
touch the panels open on tap and dismiss on an outside tap — and the same
iPad switches paradigms live when a keyboard docks or undocks. The dashboard
grid is not yet touch-rearrangeable (known, documented). Read
[docs/building.md](docs/building.md)'s iPadOS section before trying it —
`ios:dev` and `ios:build` are not two ways of doing the same thing.

**New in v6.0.0 (Ep. 6):** the analyst moves in. The right-edge **Rita
pane**: an OpenBB custom-agent-protocol client (agents.json + SSE streaming,
built against live-captured fixtures), MCP tool discovery with a byte-budget
guard, dashboard context sharing (with a privacy toggle that also gates
widget-derived MCP servers), chat persistence, markdown/table/chart
artifacts, unread-dot fold-away behavior, and conversation export/share
targets. Configure the agent URL and MCP servers in Settings; deployment
runbook for the agent itself in `deploy/spark/`.

**New in v5.0.0 (Ep. 5):** try BDOBB with **no backend of your own** —
`pnpm reference-backend` starts OpenBB's own reference implementation
(~70 widgets) on `http://127.0.0.1:7779`; import its `apps.json` from the
dashboard strip and 14 populated dashboards appear, linked parameter groups
included. The opt-in conformance suite (`pnpm test:reference`) tests the
client against the spec-owner's corpus — a disagreement there is our bug by
definition. Workspace **Import/Export** (apps.json interchange) ships here
too. See [docs/test-environment.md](docs/test-environment.md).

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

The Tauri HTTP capability allowlist is **generated** from `.env.local` by
`scripts/generate-capabilities.mjs` (run automatically by dev/build) — edit
`src-tauri/capability.template.json`, never the generated `default.json`.
With no `.env.local` the scope falls back to `https://*.ts.net/*` so a fresh
clone still builds; pass `--strict` to make that a build failure (the release
workflow does).

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

## License

MIT. The Clock widget's typeface (Erbos Draco NBP, CC BY-SA 3.0) is bundled —
attribution in `src/assets/fonts/`.
