# OpenBB Desk — Design

**Date:** 2026-07-30
**Status:** Approved; partially implemented — see *Implementation status* below.
**Working name:** OpenBB Desk (user may rename)

> **Note on hostnames.** Every host, path, key name and IP in this document and
> in the plans is a placeholder (`<agent-host>`, `$NAS_STACK_DIR`,
> `*.example.ts.net`, …). Real endpoints live in `.env.local`, which is
> gitignored. Do not reintroduce concrete values here.

## Implementation status

Recorded 2026-08-01, so the success criteria below are read against what
actually exists rather than what was intended.

| # | Criterion | Status |
|---|---|---|
| 1 | `.dmg` / `.exe` install and launch | **Not verified** — a release workflow now bundles both on a tag, but nothing has been built or launched, and there is no remote to run it |
| 2 | Left rail hover-expand | **Done** — overlay, 300 ms delay, grid never reflows |
| 3 | Right pane hover + pin + stickiness | **Done** — hover, ⌘⇧A pin and focus stickiness work. Streaming stickiness was replaced by an unread marker (see the revision note under *Right AI pane*) |
| — | Touch input (tap to open, tap outside to dismiss) | **Done for panels** — see *Input paradigms*. The dashboard grid is not yet touch-usable |
| 4 | Library → add/arrange/resize/remove; dashboards persist | **Done** — including atomic writes and serialized saves |
| 5 | Table and chart render live data | **Done** — Plotly figure JSON renders natively, table-shaped rows generate a candlestick (OHLC present) or line, and a widget with a date column offers the table↔chart toggle |
| 5a | HTML widget with working JS, `raw=true` toggle | **Done** — sandboxed JS-enabled render, the text fetch path, and a raw view that fetches `raw=true` and shows the JSON directly |
| 5b | iframe widget; `storage.mcpUrl` → `QueryRequest.tools` | **Done** — MCP transport verified against live servers |
| 6 | Chat streams with dashboard context; Rita uses tools | **Done** — streaming, full history, dashboard context, MCP tool descriptors and the `get_widget_data` round trip all ship, verified against the live agent |
| 7 | Failure surfaces degrade independently | **Done** — error boundaries per card and at root, raw-JSON fallbacks, per-backend discovery isolation |

Known gaps beyond the criteria: `agents.json` discovery never runs — the query
endpoint is built by string concatenation, so `AgentInfo.features` (which would
drive model selection) is never read. Everything else in this paragraph has
since been closed: the transcript persists to `$APPDATA/chat.json`, can be
exported to markdown or sent to another app, and an unreachable agent is
reported distinctly from one that answered with an error.

## Problem

OpenBB Workspace's layout wastes screen real estate: the left panel is permanently wide, and the AI pane cannot fold away when idle. The user wants a desktop application (macOS + Windows) with the same core experience — widget dashboards over their self-hosted OpenBB data, plus an AI analyst pane — but with panels that get out of the way: an icon-width left rail that expands on hover, and a right AI pane that folds to the edge and expands on hover.

The AI must be private: OpenBB's Agent Rita running on the user's DGX Spark box against local llama.cpp models, with tool access to the user's NAS OpenBB API and ArcticDB/kdb+ stores.

## Decision summary

Chosen approach ("Approach 4"): **Tauri 2 desktop app** (custom frontend, not a wrapper around pro.openbb.co) + **stock open-source Agent Rita on the Spark** speaking OpenBB's published custom-agent protocol. The app implements the client side of two OpenBB-published protocols:

- **widgets.json protocol** — widget discovery + data from the NAS OpenBB Platform API.
- **Custom-agent protocol** (`agents.json` + SSE query endpoint) — chat with Rita.

Rejected alternatives: wrapping hosted Workspace in Electron with injected CSS (user declined — wants a custom frontend); Electron shell (Tauri chosen: user builds Tolaria/Tauri already, smaller binaries; accepts WebView2 on Windows as second render engine); bespoke chat protocol (protocol conformance chosen so any OpenBB-compatible agent plugs in, and Rita is used stock instead of writing an agent).

## Architecture

```
┌─ Mac / Windows ──────────────┐      ┌─ Spark (agent-host) ─────┐
│  Tauri app  (openbb-desk)    │      │  Agent Rita (stock, MIT)     │
│  • dashboard grid (center)   │ SSE  │  • Vercel AI SDK →           │
│  • hover left rail           │─────▶│    llama.cpp Qwen/Gemma      │
│  • hover AI pane             │      │  • MCP tools ────────┐       │
└──────────────┬───────────────┘      └──────────────────────┼───────┘
               │ widgets.json + data                         │
        ┌──────▼──────────────────────────────────────────── ▼──────┐
        │  NAS: OpenBB Platform API  +  ArcticDB / kdb+ MCP server  │
        └───────────────────────────────────────────────────────────┘
```

Three pieces:

1. **Tauri desktop app** (`~/Developer/openbb-desk`) — new code; the bulk of the project. React + TypeScript renderer in a Tauri 2 shell.
2. **Agent Rita on the Spark** — deployment + configuration of the stock `OpenBB-finance/agent-rita` (Bun/TypeScript/Hono/Vercel AI SDK, MIT).
3. **NAS OpenBB stack** — unchanged, plus one small new MCP server for ArcticDB/kdb+ queries.

All traffic stays on the tailnet. No OpenBB cloud dependency anywhere.

## Component: desktop app

### Window and layout

Three vertical zones: left rail, center dashboard area, right AI pane. Native chrome per platform, app icon, minimal native menu (About, Quit, Reload, dev tools toggle).

### Left rail

- Collapsed: ~48px, icons only. Top group: dashboard switcher, widget library. Bottom-pinned group: backend connections, settings.
- Mouse-enter expands to ~240px as an **overlay** above the dashboard (grid never reflows). Icon + label; dashboard icon shows saved-dashboard list inline; click to switch.
- Mouse-leave collapses after ~300ms delay.
- **Touch (added 2026-08-02):** a tap on the rail expands it; a tap anywhere
  outside the rail dismisses it. See *Input paradigms* below.
- Widget library opens as a panel: search box + discovered widgets grouped by category; click to add to current dashboard.
- Backend connections and settings open as modal dialogs.

### Right AI pane

- Collapsed: ~24px strip with vertical "Rita" tab on the right edge.
- Mouse-enter expands to ~380px overlay; mouse-leave collapses after the same ~300ms delay.
- Stickiness: pane stays open while the chat input has focus, regardless of mouse position — it must not fold away mid-sentence.
- **Revised 2026-08-01:** a streaming response no longer holds the pane open. The
  original rule pinned it for the whole turn, which contradicts the premise that
  panels get out of the way: you ask a question precisely so you can keep
  working. The pane folds as normal and an unread dot appears on the collapsed
  strip, clearing when it reopens. This is only safe because the conversation
  lives in `chatStore` rather than the pane component — with the turn owned by a
  mounted component, collapsing aborted the stream and discarded the transcript,
  which is what the original rule was really working around.
- Pin button + keyboard shortcut (⌘⇧A / Ctrl⇧A): locks pane open in **docked** mode (pushes grid aside) for extended sessions. Unpin returns to hover-overlay behavior.
- **Touch (added 2026-08-02):** tap the collapsed strip to expand, tap outside
  to dismiss — the same rule as the rail. Focus stickiness still wins: while the
  chat input has focus an outside tap does not fold the pane, or the caret would
  be lost mid-sentence.

### Input paradigms

**Added 2026-08-02.** The app supports two, chosen at runtime rather than at
build time, because a single iPad switches between them when a Magic Keyboard is
docked or removed.

`usePointerKind` reads `(pointer: fine)` reactively and `AppShell` stamps
`pointer-fine` or `pointer-coarse` on the shell.

**Pointer (desktop, and iPadOS with a trackpad, mouse or Magic Keyboard).** The
hover model above, unchanged. iPadOS delivers real pointer events for these
devices, so nothing special is needed.

**Touch.** Hover has no analogue: the webview synthesises a mouse-enter on first
tap and never a leave, so a hover panel would open and never close. Instead:

- Tap the panel (rail or collapsed Rita strip) to expand it.
- **Tap anywhere outside the panel to dismiss it.**

"Outside" means anything not inside the panel's own element — including a widget
card. That is deliberate. The alternative considered was dismissing only on bare
dashboard background, which reads as more precise but strands the panel open on
a full dashboard where no bare background is left to tap. The cost is that the
dismissing tap does not also activate the card underneath; that is one extra tap,
against a panel that cannot be closed at all.

A scrim over the dashboard was also considered and rejected: it removes the
ambiguity but darkens the data the user opened the panel to consult.

Mechanics worth recording, because each is a bug if got wrong:

- The outside listener runs on `pointerdown` **in the capture phase**, so
  dismissal is decided before the tap reaches whatever is underneath.
- Both handlers ignore `pointerType === "mouse"`. iPadOS raises a synthetic
  mouse-typed event for the same tap; acting on both would open from one and
  toggle on the other, so a single tap would net to nothing.
- The listener is only attached when the pointer is coarse **and** the panel is
  open. With a mouse, mouse-leave already collapses the panel, and a second
  mechanism would close it on any click elsewhere in the app.

Still unresolved for touch: the dashboard grid. react-grid-layout's drag
competes with scrolling, so cards will need an explicit drag handle. Panels are
usable by touch; rearranging a dashboard is not yet.

### Dashboard grid (center)

- `react-grid-layout`: drag, resize, remove widget cards. Active dashboard name in a top strip.
- Dashboards persist as JSON files (widget set, positions, per-widget parameters, view mode) in the app data directory — plain files the user can back up.

### Widget system

- **Discovery:** on launch and manual refresh, fetch `widgets.json` from each configured backend (v1: the NAS API only, but the backend list is plural by design). Entries populate the widget library.
- **Table renderer:** TanStack Table. Sortable columns, type-aware formatting (dates, percentages, large numbers), column resize.
- **Chart renderer:** **plotly.js** (MIT). Two paths: (a) endpoints that return OpenBB `openbb-charting` Plotly figure JSON render natively; (b) table-shaped time-series data gets a generated candlestick (when OHLC columns present) or line chart. Widgets with a date/time column can toggle table ↔ chart view.
- **HTML renderer (v1 requirement):** widgets declared `"type": "html"` render the endpoint's server-generated HTML in a sandboxed iframe inside the widget card, **with JavaScript execution enabled** (matching OpenBB's self-hosted/enterprise behavior — backends are the user's own, on the tailnet). Parameters append to the query string as with other widget types; refresh re-fetches. Where the endpoint supports the `raw=true` convention, the card gains a toggle to the JSON-as-table view, and `raw` JSON (not HTML) is what feeds AI dashboard context. The widget→host `CustomEvent` bridge (widgets pushing parameter values back to the host) is deferred from v1 unless plan-time research shows it is trivial; deferral noted in open items.
- **Iframe renderer (v1 requirement, added 2026-07-30):** widgets declared `"type": "iframe"` render with `endpoint` used verbatim as the iframe `src` (a full URL, not a backend path) — same iframe component as the HTML renderer, JS enabled. A widget's optional `storage.mcpUrl` field names an MCP server to auto-connect while the widget is on the active dashboard (see AI integration). OpenBB's iframe postMessage protocol (`openbb-connect` handshake, `openbb-params-update` parameter sync) is deferred from v1 alongside the CustomEvent bridge.
- **Parameters:** widget-card header with controls generated from the widget definition (text for ticker, date pickers, dropdowns for enums), refresh button, view toggle. Values persist with the dashboard.
- **Data flow:** renderer → HTTP fetch to widget endpoint with current params → JSON → render. No caching layer in v1; fetch on demand or dashboard load only, no polling.
- **Deferred:** Workspace-style parameter grouping (shared ticker across widgets) — most likely first enhancement, out of v1.

### Chat pane behavior

- Implements the OpenBB custom-agent protocol client: fetch `agents.json` from the configured Rita URL to register the agent; POST queries to the SSE endpoint; render streamed events — text deltas, reasoning/status steps, table artifacts (TanStack) and chart artifacts (plotly.js).
- Protocol is stateless: the app sends full conversation history each turn. Chat history lives in app local storage.
- **Export (added 2026-08-01):** a conversation can be saved as a markdown file
  via a native Save dialog, containing the transcript, table artifacts as
  markdown tables, chart artifacts as their figure JSON, and the API calls made
  while answering. Widget requests are recorded in full (resolved URL,
  parameters, outcome, timing, row count); agent-side tools appear only as the
  agent narrates them in status updates, and the file states that limit rather
  than implying a complete audit trail.
- **Dashboard context:** each `QueryRequest` carries the active dashboard's widget definitions, current parameters, and current data for reasonably-sized tables (size threshold decided at plan time), so questions about what's on screen work Rita-style. HTML widgets contribute their `raw=true` JSON when the endpoint supports it, and are otherwise listed by definition/parameters only (no HTML parsing in v1). Settings toggle disables context sharing.

## Component: Agent Rita on the Spark

- Stock `OpenBB-finance/agent-rita`, cloned to the Spark under the `dev` account, run under Bun as a systemd service on port 8002, tailnet-only (same posture as the llama.cpp servers).
- **Model:** Vercel AI SDK OpenAI-compatible provider → `http://<spark-ts-ip>:8000/v1` (Qwen3-Coder), authenticated with a new per-consumer key `$AGENT_API_KEY` added to the qwen keys file (llama.cpp `--api-key-file` scheme; key changes need a server restart). Model endpoint/name configurable; app Settings surfaces the choice so Gemma (port 8001) can be selected later.
- **Tools (MCP):**
  1. **NAS OpenBB API** — via OpenBB Platform's MCP server mode. Plan-time verification: confirm the 4.7.x container ships `openbb-mcp-server` (or add it to the image via the `update-openbb-docker` skill flow).
  2. **ArcticDB / kdb+** — a small purpose-built read-only MCP server (Python) running on the NAS beside the stores: list symbols/libraries, read date range, last-N rows. Lives in the openbb-docker repo family.
- **Tool assembly rule (client side):** the tool descriptors sent in each `QueryRequest.tools` are the union of (a) MCP servers configured in Settings and (b) the `storage.mcpUrl` servers of widgets on the active dashboard (per-widget MCP auto-connect, matching Workspace's iframe-widget behavior). Discovery (`initialize` + `tools/list`) is cached per session.
- Rita deployment config (systemd unit, env, MCP config, setup notes) is versioned; location (a `spark/` dir in openbb-desk vs. the existing Spark Gitea mirroring flow) decided at plan time.

## Error handling

Three independent failure surfaces; each degrades without blocking the others:

- **NAS API unreachable:** widget cards render inline error state + retry button; backend marked offline in connections dialog; app never blocks at launch — dashboards render saved layout with error cards.
- **Rita/Spark unreachable:** AI pane shows "Rita offline" naming the failing endpoint, distinguishing Rita-unreachable from Rita-up-but-model-errored. Dashboards unaffected.
- **Malformed data:** unexpected response shapes render a raw-JSON fallback view, never a blank card.

All errors go to a rotating app log file viewable from Settings (Windows debugging without dev tools).

## Testing

- **Unit (vitest):** widgets.json parsing, parameter-control generation, table/chart shape detection, SSE event parsing against recorded Rita fixtures.
- **Integration:** widget client + agent client against a tiny mock server (canned widgets.json, data, SSE streams) — CI needs no live NAS/Spark.
- **E2E (manual scripted checklist):** against real NAS + Rita — panels, hover mechanics, persistence, streaming chat with context.
- **Rita smoke test:** `curl` against `agents.json` and a canned SSE query on the Spark before the app connects.

**As built (2026-08-01).** Unit and component coverage is real: 252 passing,
`tsc --noEmit` clean. A recorded Rita SSE stream lives at
`src/test/fixtures/rita-stream.sse` and is replayed at a 7-byte chunk size to
prove framing survives mid-event boundaries. `src/test/mockServer.ts` serves
canned `widgets.json` and data over real HTTP, but **has no SSE route** — agent
integration is covered by the recorded fixture instead.

Divergences worth knowing:

- An automated "e2e" suite existed and was deleted: it mocked every store and
  asserted against object literals declared in the same file, so it executed no
  product code. The spec always scoped E2E as a *manual* checklist, and that
  checklist has not been written.
- The Rita smoke test is automated rather than manual `curl`, in
  `src/test/integration/`, gated behind `OPENBB_LIVE=1` and reading endpoints
  from `.env.local`. It also covers MCP `initialize` → `tools/list` against the
  real servers. It is skipped by default so CI needs no live backend.
- CI runs typecheck, tests and the web build on push and PR (`.github/workflows/ci.yml`), and needs no live backend. `pnpm test` is watch mode; CI uses `pnpm test:run`.

## Packaging and distribution

- Tauri 2 bundler: macOS `.dmg` (Apple Silicon), Windows NSIS `.exe` (x64). **Unsigned** — one-time right-click-Open / SmartScreen dismissal. No auto-update in v1.
- macOS builds locally on the user's Mac; Windows builds via GitHub Actions (standard Tauri CI).
- Repo: `~/Developer/openbb-desk`, private GitHub remote (Windows CI needs GitHub Actions; large-push TLS gotcha noted in user memory — use gh API upload if it bites).

## Success criteria (v1 done)

1. Mac `.dmg` and Windows `.exe` install and launch as normal apps.
2. Left rail: icon-width at rest, hover-expands, dashboards + widget library, backends/settings pinned bottom.
3. Right pane: folded at rest, hover-expands, pin + focus stickiness work; a response arriving while collapsed raises an unread marker.
4. Widget library lists NAS-discovered widgets; add/arrange/resize/remove on the grid; dashboards persist across restarts.
5. Table and chart widgets render live NAS data, including OpenBB-generated Plotly figures.
5a. An HTML-type widget (`"type": "html"`) renders its server-generated HTML with working JavaScript interactivity, and toggles to the `raw=true` table view where the endpoint supports it.
5b. An iframe-type widget (`"type": "iframe"`) renders its URL, and a widget carrying `storage.mcpUrl` contributes that server's tools to Rita's `QueryRequest.tools` while on the active dashboard.
6. Chat pane streams Rita answers from the Spark with active-dashboard context; Rita answers questions requiring the NAS OpenBB API and ArcticDB/kdb+ tools.
7. Failure surfaces degrade per the error-handling section.

## Implementation decomposition

Two implementation plans, buildable and testable independently:

1. **Desktop app** (the bulk): scaffold → layout/panels → widget system → chat client → packaging.
2. **Spark/NAS AI stack:** Rita deployment + `$AGENT_API_KEY` + OpenBB MCP server verification + ArcticDB/kdb MCP server.

Process notes (user-directed): planning and implementation use subagents (superpowers subagent-driven development); where superpowers process specifies older Opus models for code review, use **Opus 5**.

## Open items resolved at plan time

- Exact OpenBB agent-protocol event schema version to pin (from `openbb-ai` / `agents-for-openbb` repos).
- Whether the 4.7.x NAS container already ships `openbb-mcp-server`.
- Dashboard-context table-size threshold.
- HTML-widget `CustomEvent` bridge (widget pushing values back to the host): include in v1 only if trivial, else defer.
- iframe sandbox attribute set for HTML widgets (JS enabled, but which other capabilities — forms, popups, same-origin — are allowed).
- Rita deploy-config location (openbb-desk `spark/` dir vs. Spark Gitea flow).
- App display name / icon (user decision; working name OpenBB Desk).
