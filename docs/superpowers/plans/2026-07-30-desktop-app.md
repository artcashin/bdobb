# OpenBB Desk Desktop App Implementation Plan

> **Status: executed, with divergences. Read the table below before treating
> anything here as a description of the code.** This is a record of intent
> written 2026-07-30. Where the build differs, the code is correct and this
> document is not. Status recorded 2026-08-01.
>
> **Hostnames are placeholders** (`<agent-host>`, `$NAS_STACK_DIR`,
> `*.example.ts.net`, `$AGENT_API_KEY`). Real values live in gitignored
> `.env.local`. Do not reintroduce concrete values here.

## What actually shipped

| Task | Status |
|---|---|
| 1 Scaffold, Tauri config, capabilities, harness | Done. Capabilities are now **generated** from `.env.local` by `scripts/generate-capabilities.mjs`; edit `default.template.json`, not `default.json` |
| 2 Widget types, widgets.json parser | Done. `WidgetDef` also carries `backendId`, which the plan did not anticipate and which the registry needs to keep two backends' widgets distinct |
| 3 Widget data client + mock server | Done |
| 4 Persistence and rotating logger | Done. Writes are atomic (temp + rename) and `loadDashboards` dedupes concurrent callers — neither is in the plan, both were needed |
| 5 Zustand stores | Done, but with **one** dashboard-selection field (`activeId`). An early build carried two (`activeId` + `currentDashboardId`) written by different code paths, which made the grid render "No dashboard selected" over saved dashboards |
| 6 useHoverPanel, shell, rail, Rita chrome | Done |
| 7 Dashboard grid, tabs, card chrome | Done. The grid issues one batched `updateLayouts` per change; per-item writes completed out of order and persisted stale positions |
| 8 Widget library panel | Done |
| 9 Parameter engine + card-header controls | Done. `src/lib/params.ts` resolves `$currentDate` with offsets; a new card seeds from the widget's defaults, and the card header edits and persists them |
| 10 Data-fetch hook, table renderer, raw-JSON fallback | Done, with one deviation: there is no `useWidgetData` hook — `WidgetCard` fetches directly. Sorting, type-aware formatting and column resize all work |
| 11 Chart renderer + table↔chart toggle | Done. `src/lib/chartShapes.ts` implements the planned interface; `card.view` now drives rendering. Column resize (Task 10) is still absent |
| 12 HTML, iframe, markdown, metric, unsupported renderers | Done. Malformed payloads fall through to `RawJsonView` rather than blank cards |
| 13 Agent protocol types + SSE parser | Done. Parser normalises CRLF and strips the optional space after `data:` — both were wrong initially and only surfaced against a real stream |
| 14 Agent client — query, get_widget_data, abort | **Partial.** `runAgentQuery`, the function-call loop, the `get_widget_data` round trip and abort all ship and are verified against the live agent. `fetchAgentsJson` still has no caller: the query endpoint is built by string concatenation rather than read from `agents.json` |
| 15 MCP discovery and tool assembly | Done, and verified against live servers. The plan's interface was right and an earlier implementation ignored it entirely; see the note below |
| 16 Chat pane UI | Done. Streams text, renders reasoning steps, artifacts, citations and suggestions; the transcript persists across restarts; an unreachable agent is reported distinctly from one that errored |
| 17 Backends and Settings dialogs | Done |
| 18 Icon, bundle, GitHub repo, Windows CI, README | **Partial.** CI and release workflows exist and the CI job passes locally against a clean checkout. Never packaged, and no remote — the workflows are dormant until one is added |

**On Task 15.** The first implementation ignored this plan's interface and could
not complete a handshake with a conformant server: it sent `Accept:
application/json` alone (servers answer 406), never captured `Mcp-Session-Id`,
pinned `protocolVersion: 2024-11-05`, skipped `notifications/initialized`, and
called `res.json()` on `text/event-stream` bodies. The rewrite follows the plan
and is verified live. The lesson is in the plan's favour — the interface it
specified existed because these requirements are not guessable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the OpenBB Desk desktop app — a Tauri 2 (React + TypeScript) client for the user's self-hosted OpenBB stack: hover-collapsing left rail and right AI pane, a react-grid-layout widget dashboard speaking the OpenBB widgets.json protocol against the NAS backend, and a chat pane speaking the OpenBB custom-agent SSE protocol against Agent Rita on the Spark.

**Architecture:** Three vertical zones (left rail overlay, center dashboard grid, right Rita pane overlay/dockable) rendered by React in a Tauri 2 shell. All widget/data HTTP goes through `@tauri-apps/plugin-http` (bypasses CORS); only the agent SSE stream uses native `window.fetch`. Pure protocol logic (widgets.json parsing, URL building, `$currentDate` resolution, SSE parsing, agent round-trips, MCP discovery) lives in dependency-free TypeScript modules under `src/lib/` with vitest coverage; React components consume them. State in zustand stores; persistence as plain JSON files in `$APPDATA` via `@tauri-apps/plugin-fs`; a tiny hand-rolled logger writes a rotating log file (no tauri-plugin-log).

**Tech Stack:** Tauri 2.11.x stable (`@tauri-apps/cli ^2`), React 19 + TypeScript + Vite, pnpm, react-grid-layout, @tanstack/react-table, plotly.js-dist-min, react-markdown, zustand, @tauri-apps/plugin-http, @tauri-apps/plugin-fs. Tests: vitest + @testing-library/react + jsdom. Rust side: tauri-plugin-http, tauri-plugin-fs. Plain CSS (one stylesheet, CSS variables) — **no Tailwind**.

## Global Constraints

- Repo root: `$REPO_ROOT` (git already initialized; has `docs/` and `.gitignore`). The Tauri scaffold lives at the **repo root** (`package.json` at root, `src-tauri/` subdir).
- App identity: productName `OpenBB Desk`, identifier `com.<owner>.openbb-desk`, main window 1440x900, min 1024x700, title `OpenBB Desk`.
- Package manager is **pnpm** for everything (`pnpm add`, `pnpm vitest run`, `pnpm tauri dev`).
- Dark UI throughout; theme value is always `"dark"` in v1; pass `theme=dark` as a query param to **chart and html** widgets only (never iframe, never table).
- HTTP capability scope is minimal: `https://*.example.ts.net`, `:8443`, `:8444`, and `http://agent-host:8002`. The user widens this list by hand when adding backends outside the tailnet — note this in README (Task 18), do not build UI for it.
- Backend base URL (seeded default): `https://openbb.example.ts.net` — no auth (tailnet). `GET /widgets.json` returns a JSON **object keyed by widgetId** (442 entries live; types present: chart, html, markdown, multi_file_viewer, pdf, table).
- Rita base URL (seeded default): `http://agent-host:8002`. Agent protocol pinned to **openbb-ai v2.1.0** models.
- Default MCP servers (seeded): `https://openbb.example.ts.net:8443/mcp/` and `https://openbb.example.ts.net:8444/mcp/`.
- `refetchInterval` / `staleTime` in widgets.json are parsed but **ignored** in v1 (no polling; fetch on demand/dashboard load only).
- Param types `form` and `tabs` are unsupported in v1: hide the control, log once via the logger.
- Widget types `multi_file_viewer` and `pdf` render an "Unsupported in v1" card.
- Dashboard context sent to Rita = widget definitions + current parameters only; the agent pulls data via the `get_widget_data` function round-trip. **Never push table data proactively** (this resolves the spec's "table-size threshold" open item: no threshold needed).
- Deferred from v1 (spec-sanctioned): HTML-widget `CustomEvent` bridge, iframe `openbb-connect`/`openbb-params-update` postMessage protocol, Workspace-style parameter grouping, refresh scheduling, auto-update, code signing.
- iframe sandboxing (resolves spec open item): html-type widgets render in `<iframe srcdoc sandbox="allow-scripts allow-forms allow-popups">` (JS on, **no** `allow-same-origin` — srcdoc + same-origin would defeat the sandbox); iframe-type widgets render `<iframe src sandbox="allow-scripts allow-same-origin allow-forms allow-popups">` (real remote origin needs its own cookies/storage to function).
- Every error path calls the logger (Task 4); never a blank card — unexpected shapes fall back to raw JSON `<pre>`.
- Tests: every pure module gets vitest tests; UI steps that aren't unit-testable say exactly what to verify manually in `pnpm tauri dev`.
- Commits: conventional-commit style messages, one commit per task minimum, exact commands given per task.
- The Spark/NAS AI stack (Rita deployment, `$AGENT_API_KEY`, ArcticDB/kdb MCP server) is a **separate plan** — nothing in this plan touches the Spark or NAS.

### File structure (end state)

```
$REPO_ROOT/
├── package.json, vite.config.ts, tsconfig.json, index.html
├── src-tauri/
│   ├── tauri.conf.json, Cargo.toml, capabilities/default.json
│   └── src/{main.rs, lib.rs}
├── scripts/make-icon.mjs
├── .github/workflows/windows-build.yml
├── src/
│   ├── main.tsx, App.tsx, styles.css
│   ├── types/plotly.d.ts
│   ├── lib/
│   │   ├── types.ts            # all shared protocol/domain types
│   │   ├── widgets.ts          # widgets.json parsing/normalization
│   │   ├── dataClient.ts       # URL building, fetch, dataKey extraction
│   │   ├── params.ts           # $currentDate resolver, initial values, options resolution
│   │   ├── chartShapes.ts      # figure detection, records→figure
│   │   ├── persistence.ts      # $APPDATA JSON files (settings/backends/dashboards)
│   │   ├── logger.ts           # rotating $APPDATA/logs/openbb-desk.log
│   │   └── agent/
│   │       ├── types.ts        # agent protocol types (openbb-ai v2.1.0)
│   │       ├── sse.ts          # SSE stream parser
│   │       ├── agentClient.ts  # agents.json, query round-trips, get_widget_data
│   │       └── mcp.ts          # MCP discovery + tool assembly
│   ├── stores/
│   │   ├── settingsStore.ts, backendsStore.ts, registryStore.ts, dashboardStore.ts
│   ├── hooks/
│   │   ├── useHoverPanel.ts, useWidgetData.ts
│   ├── components/
│   │   ├── AppShell.tsx, LeftRail.tsx, RitaPane.tsx
│   │   ├── DashboardTabs.tsx, DashboardGrid.tsx, WidgetCard.tsx, WidgetBody.tsx
│   │   ├── WidgetLibrary.tsx, ParamControls.tsx, Modal.tsx
│   │   ├── renderers/{TableRenderer,ChartRenderer,HtmlRenderer,IframeRenderer,MarkdownRenderer,MetricRenderer,UnsupportedRenderer,RawJsonView}.tsx
│   │   ├── chat/{ChatPane,ChatMessages,ArtifactView}.tsx
│   │   └── dialogs/{BackendsDialog,SettingsDialog}.tsx
│   └── test/
│       ├── setup.ts, memfs.ts, mockServer.ts
│       └── fixtures/{widgets.fixture.json, historical.fixture.json, rita-stream.fixture.ts}
└── docs/superpowers/...
```

---

### Task 1: Scaffold, Tauri config, plugins, capabilities, test harness

**Files:**
- Create: entire Tauri scaffold at `$REPO_ROOT/` (package.json, index.html, vite.config.ts, tsconfig.json, src/, src-tauri/)
- Modify: `$REPO_ROOT/src-tauri/tauri.conf.json`
- Modify: `$REPO_ROOT/src-tauri/Cargo.toml`
- Modify: `$REPO_ROOT/src-tauri/src/lib.rs`
- Create: `$REPO_ROOT/src-tauri/capabilities/default.json` (overwrite scaffold's)
- Create: `$REPO_ROOT/src/test/setup.ts`
- Create: `$REPO_ROOT/src/test/smoke.test.ts`
- Create: `$REPO_ROOT/src/types/plotly.d.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a building Tauri 2 app named "OpenBB Desk"; `pnpm vitest run` works; `@tauri-apps/plugin-http` and `@tauri-apps/plugin-fs` registered and scoped. Later tasks import `fetch` from `@tauri-apps/plugin-http` and fs functions from `@tauri-apps/plugin-fs` and rely on the capability scope defined here.

- [ ] **Step 1: Scaffold into the existing repo**

`pnpm create tauri-app` refuses a non-empty directory, so scaffold to a temp dir and move files in:

```bash
cd /Users/<owner>/Developer
pnpm create tauri-app openbb-desk-scaffold --template react-ts --manager pnpm --yes
# Move everything (including dotfiles) into the real repo; do NOT overwrite the existing .gitignore blindly
rsync -a --exclude .git $REPO_ROOT-scaffold/ $REPO_ROOT/
rm -rf $REPO_ROOT-scaffold
cd $REPO_ROOT
```

The scaffold ships its own `.gitignore`; the repo's existing one already covers `node_modules/`, `target/`, `dist/`, `.claude/settings.local.json`. After the rsync, open `.gitignore` and make sure all four of those entries are still present (rsync overwrote it with the scaffold's version — re-add any of the four that are missing, keeping the scaffold's entries too).

- [ ] **Step 2: Install JS dependencies**

```bash
cd $REPO_ROOT
pnpm install
pnpm add react-grid-layout react-resizable @tanstack/react-table plotly.js-dist-min react-markdown zustand @tauri-apps/plugin-http @tauri-apps/plugin-fs
pnpm add -D vitest @testing-library/react @testing-library/jest-dom jsdom @types/react-grid-layout
```

Expected: all installs succeed. (`react-resizable` is added explicitly because react-grid-layout's CSS lives there and pnpm's strict node_modules won't resolve it transitively.)

- [ ] **Step 3: Replace `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "OpenBB Desk",
  "version": "0.1.0",
  "identifier": "com.<owner>.openbb-desk",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "OpenBB Desk",
        "width": 1440,
        "height": 900,
        "minWidth": 1024,
        "minHeight": 700
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 4: Register the Rust plugins**

```bash
cd $REPO_ROOT/src-tauri
cargo add tauri-plugin-http tauri-plugin-fs
```

Then replace `src-tauri/src/lib.rs` with (keep `tauri_plugin_opener` only if the scaffold included it in Cargo.toml — the scaffold's react-ts template does; shown included here):

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Write `src-tauri/capabilities/default.json`** (overwrite the scaffold's file)

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "OpenBB Desk main window: tailnet HTTP + $APPDATA fs",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    {
      "identifier": "http:default",
      "allow": [
        { "url": "https://*.example.ts.net/*" },
        { "url": "https://*.example.ts.net:8443/*" },
        { "url": "https://*.example.ts.net:8444/*" },
        { "url": "http://agent-host:8002/*" }
      ]
    },
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "fs:allow-mkdir",
    "fs:allow-exists",
    "fs:allow-read-dir",
    "fs:allow-rename",
    "fs:allow-remove",
    "fs:allow-stat",
    {
      "identifier": "fs:scope",
      "allow": [{ "path": "$APPDATA" }, { "path": "$APPDATA/**" }]
    }
  ]
}
```

NOTE (put this as a comment in the README later, JSON has no comments): the http allow-list is deliberately minimal — the user widens it by editing this file when adding a backend outside the tailnet.

- [ ] **Step 6: Wire vitest into `vite.config.ts`** (replace the whole file)

```ts
/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/api needs the host set for mobile dev; harmless on desktop
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

Add to `package.json` `"scripts"`: `"test": "vitest run"` (keep the scaffold's existing `dev`, `build`, `preview`, `tauri` scripts).

- [ ] **Step 7: Create `src/test/setup.ts` and a smoke test**

`src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`src/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs with jsdom", () => {
    const el = document.createElement("div");
    el.textContent = "openbb-desk";
    expect(el).toHaveTextContent("openbb-desk");
  });
});
```

- [ ] **Step 8: Create `src/types/plotly.d.ts`** (plotly.js-dist-min ships no types)

```ts
declare module "plotly.js-dist-min" {
  const Plotly: {
    newPlot: (
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<void>;
    react: (
      el: HTMLElement,
      data: unknown[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>
    ) => Promise<void>;
    purge: (el: HTMLElement) => void;
  };
  export default Plotly;
}
```

- [ ] **Step 9: Run the smoke test**

Run: `pnpm vitest run src/test/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 10: Verify the shell builds and launches**

Run: `pnpm tauri dev`
Manually verify: a window titled "OpenBB Desk" opens at 1440x900, cannot be resized below 1024x700, shows the scaffold's default React page. Quit it.
(If the first Rust compile is slow that is normal — several minutes.)

- [ ] **Step 11: Commit**

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: scaffold Tauri 2 app with http/fs plugins, tailnet capability scope, vitest harness"
```

---
### Task 2: Widget types, widgets.json parser, real fixtures

**Files:**
- Create: `$REPO_ROOT/src/lib/types.ts`
- Create: `$REPO_ROOT/src/lib/widgets.ts`
- Create: `$REPO_ROOT/src/test/fixtures/widgets.fixture.json`
- Create: `$REPO_ROOT/src/test/fixtures/historical.fixture.json`
- Test: `$REPO_ROOT/src/lib/widgets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (every later task imports from `src/lib/types.ts`):
  - `WidgetDef { id, name, description, category, subCategory, type, endpoint, gridData, source, runButton, raw, refetchInterval, params, dataKey, columnsDefs, mcpUrl }`
  - `ParamDef { paramName, type, value, label, description, show, multiSelect, options, optionsEndpoint, optionsParams }`
  - `ColumnDef`, `GridData`, `ParamOption`, `CellDataType`, `FormatterFn`
  - `BackendConfig { id, name, baseUrl, headerName?, headerValue? }`
  - `ParamValues = Record<string, string | number | boolean | string[] | null>`
  - `DashboardCard { uuid, widgetId, backendId, layout: {x,y,w,h}, params: ParamValues, view: "default"|"raw"|"chart" }`, `Dashboard { id, name, cards }`, `CardView`, `CardLayout`
  - `Settings { ritaUrl, theme: "dark", contextSharing, mcpServers: McpServerConfig[] }`, `McpServerConfig { id, url, enabled }`
  - From `src/lib/widgets.ts`: `parseWidgetsJson(json: unknown): WidgetDef[]` and `parseWidgetEntry(id: string, raw: Record<string, unknown>): WidgetDef`

- [ ] **Step 1: Write the fixture files**

`src/test/fixtures/widgets.fixture.json` — four REAL entries. The first three are verbatim from the live NAS `GET https://openbb.example.ts.net/widgets.json` (captured 2026-07-30); the fourth (`portfolio_iframe`) is the doc-derived iframe example (no iframe widget exists on the NAS yet):

```json
{
  "equity_price_historical_eodhd_obb": {
    "name": "Historical",
    "description": "Get historical price data for a given stock. This includes open, high, low, close, and volume.",
    "category": "Equity",
    "type": "table",
    "widgetId": "equity_price_historical_eodhd_obb",
    "mcp_tool": {
      "mcp_server": "Open Data Platform",
      "tool_id": "equity_price_historical"
    },
    "params": [
      {
        "label": "Symbol",
        "description": "Symbol to get data for. Multiple comma separated items allowed.",
        "optional": false,
        "type": "text",
        "value": null,
        "show": true,
        "multiSelect": true,
        "paramName": "symbol",
        "multiple": true,
        "style": { "popupWidth": 400 }
      },
      {
        "label": "Interval",
        "description": "Time interval of the data to return.",
        "optional": true,
        "type": "text",
        "value": "1d",
        "show": true,
        "options": [
          { "label": "1m", "value": "1m" },
          { "label": "5m", "value": "5m" },
          { "label": "1h", "value": "1h" },
          { "label": "1d", "value": "1d" },
          { "label": "1W", "value": "1W" },
          { "label": "1M", "value": "1M" }
        ],
        "paramName": "interval"
      },
      {
        "label": "Exchange",
        "description": "EODHD exchange code appended to bare symbols (e.g. 'US', 'LSE', 'TO'). Ignored when the symbol is already qualified, like 'AAPL.US'.",
        "optional": true,
        "type": "text",
        "value": "US",
        "show": true,
        "paramName": "exchange"
      },
      { "paramName": "provider", "value": "eodhd", "show": false }
    ],
    "endpoint": "/api/v1/equity/price/historical",
    "runButton": false,
    "gridData": { "w": 40, "h": 15 },
    "data": {
      "dataKey": "results",
      "table": {
        "showAll": true,
        "columnsDefs": [
          { "field": "date", "pinned": "left", "formatterFn": null, "headerName": "Date", "headerTooltip": "The date of the data.", "cellDataType": "date" },
          { "field": "open", "formatterFn": null, "headerName": "Open", "headerTooltip": "The open price.", "cellDataType": "number" },
          { "field": "high", "formatterFn": null, "headerName": "High", "headerTooltip": "The high price.", "cellDataType": "number" },
          { "field": "low", "formatterFn": null, "headerName": "Low", "headerTooltip": "The low price.", "cellDataType": "number" },
          { "field": "close", "formatterFn": null, "headerName": "Close", "headerTooltip": "The close price.", "cellDataType": "number" },
          { "field": "volume", "formatterFn": null, "headerName": "Volume", "headerTooltip": "The trading volume.", "cellDataType": "number" },
          { "field": "vwap", "formatterFn": null, "headerName": "Vwap", "headerTooltip": "Volume Weighted Average Price over the period.", "cellDataType": "number" },
          { "field": "adjusted_close", "formatterFn": null, "headerName": "Adjusted Close", "headerTooltip": "Split/dividend-adjusted closing price (EOD endpoint only).", "cellDataType": "number" }
        ],
        "enableAdvanced": true
      }
    },
    "source": ["Eodhd"],
    "subCategory": "Price"
  },
  "imf_utils_presentation_table_custom_obb": {
    "name": "IMF Presentation Table",
    "description": "Presentation tables from the IMF database.",
    "category": "IMF Utilities",
    "type": "html",
    "widgetId": "imf_utils_presentation_table_custom_obb",
    "mcp_tool": {
      "mcp_server": "Open Data Platform",
      "tool_id": "imf_utils_presentation_table"
    },
    "params": [
      {
        "label": "Dataflow",
        "description": "The IMF dataflow group.",
        "optional": true,
        "type": "endpoint",
        "value": null,
        "show": true,
        "paramName": "dataflow_group",
        "optionsEndpoint": "/api/v1/imf_utils/presentation_table_choices"
      },
      {
        "label": "Table",
        "description": "The IMF presentation table.",
        "optional": true,
        "type": "endpoint",
        "value": null,
        "show": true,
        "paramName": "table",
        "optionsEndpoint": "/api/v1/imf_utils/presentation_table_choices",
        "optionsParams": { "dataflow_group": "$dataflow_group" }
      },
      {
        "label": "Country",
        "description": "Country or region for the table.",
        "optional": true,
        "type": "endpoint",
        "value": null,
        "show": true,
        "paramName": "country",
        "multiSelect": true,
        "optionsEndpoint": "/api/v1/imf_utils/presentation_table_choices",
        "optionsParams": {
          "dataflow_group": "$dataflow_group",
          "table": "$table",
          "dimension_values": "$dimension_values"
        }
      },
      {
        "label": "Frequency",
        "description": "The data frequency.",
        "optional": true,
        "type": "endpoint",
        "value": null,
        "show": true,
        "paramName": "frequency",
        "optionsEndpoint": "/api/v1/imf_utils/presentation_table_choices",
        "optionsParams": {
          "dataflow_group": "$dataflow_group",
          "table": "$table",
          "country": "$country",
          "dimension_values": "$dimension_values"
        }
      },
      {
        "label": "Dimension Values",
        "description": "Dimension selection for filtering. Format: 'DIM_ID1:VAL1+VAL2.'",
        "optional": true,
        "type": "text",
        "value": null,
        "show": true,
        "paramName": "dimension_values",
        "multiple": true,
        "multiSelect": false
      },
      {
        "label": "Limit",
        "description": "Most recent N records to retrieve per series.",
        "optional": true,
        "type": "number",
        "value": 3,
        "show": true,
        "paramName": "limit"
      },
      {
        "label": "Raw",
        "description": "Return presentation table as raw JSON data if True.",
        "optional": true,
        "type": "boolean",
        "value": false,
        "show": false,
        "paramName": "raw"
      }
    ],
    "endpoint": "/api/v1/imf_utils/presentation_table",
    "runButton": false,
    "gridData": { "w": 40, "h": 15 },
    "data": { "dataKey": "", "table": { "showAll": true } },
    "source": ["IMF"],
    "subCategory": "Presentation Tables",
    "raw": true,
    "refetchInterval": false
  },
  "equity_price_historical_eodhd_obb_chart": {
    "name": "Historical (Chart)",
    "description": "Get historical price data for a given stock. This includes open, high, low, close, and volume.",
    "category": "Equity",
    "type": "chart",
    "widgetId": "equity_price_historical_eodhd_obb_chart",
    "mcp_tool": {
      "mcp_server": "Open Data Platform",
      "tool_id": "equity_price_historical"
    },
    "params": [
      {
        "label": "Symbol",
        "description": "Symbol to get data for. Multiple comma separated items allowed.",
        "optional": false,
        "type": "text",
        "value": null,
        "show": true,
        "multiSelect": true,
        "paramName": "symbol",
        "multiple": true,
        "style": { "popupWidth": 400 }
      },
      {
        "label": "Interval",
        "description": "Time interval of the data to return.",
        "optional": true,
        "type": "text",
        "value": "1d",
        "show": true,
        "options": [
          { "label": "1m", "value": "1m" },
          { "label": "5m", "value": "5m" },
          { "label": "1h", "value": "1h" },
          { "label": "1d", "value": "1d" },
          { "label": "1W", "value": "1W" },
          { "label": "1M", "value": "1M" }
        ],
        "paramName": "interval"
      },
      {
        "label": "Exchange",
        "description": "EODHD exchange code appended to bare symbols (e.g. 'US', 'LSE', 'TO'). Ignored when the symbol is already qualified, like 'AAPL.US'.",
        "optional": true,
        "type": "text",
        "value": "US",
        "show": true,
        "paramName": "exchange"
      },
      { "paramName": "provider", "value": "eodhd", "show": false },
      {
        "paramName": "chart",
        "label": "Chart",
        "description": "Returns chart",
        "optional": true,
        "value": true,
        "type": "boolean",
        "show": false
      }
    ],
    "endpoint": "/api/v1/equity/price/historical",
    "runButton": false,
    "gridData": { "w": 40, "h": 20 },
    "data": {
      "dataKey": "chart.content",
      "table": {
        "showAll": true,
        "columnsDefs": [
          { "field": "date", "pinned": "left", "formatterFn": null, "headerName": "Date", "headerTooltip": "The date of the data.", "cellDataType": "date" },
          { "field": "open", "formatterFn": null, "headerName": "Open", "headerTooltip": "The open price.", "cellDataType": "number" },
          { "field": "high", "formatterFn": null, "headerName": "High", "headerTooltip": "The high price.", "cellDataType": "number" },
          { "field": "low", "formatterFn": null, "headerName": "Low", "headerTooltip": "The low price.", "cellDataType": "number" },
          { "field": "close", "formatterFn": null, "headerName": "Close", "headerTooltip": "The close price.", "cellDataType": "number" },
          { "field": "volume", "formatterFn": null, "headerName": "Volume", "headerTooltip": "The trading volume.", "cellDataType": "number" },
          { "field": "vwap", "formatterFn": null, "headerName": "Vwap", "headerTooltip": "Volume Weighted Average Price over the period.", "cellDataType": "number" },
          { "field": "adjusted_close", "formatterFn": null, "headerName": "Adjusted Close", "headerTooltip": "Split/dividend-adjusted closing price (EOD endpoint only).", "cellDataType": "number" }
        ],
        "enableAdvanced": true
      }
    },
    "source": ["Eodhd"],
    "subCategory": "Price",
    "defaultViz": "chart"
  },
  "portfolio_iframe": {
    "name": "Portfolio Dashboard (Streamlit)",
    "description": "Embedded Streamlit portfolio app with MCP tools",
    "category": "Portfolio",
    "type": "iframe",
    "endpoint": "http://localhost:8501",
    "storage": { "mcpUrl": "http://localhost:7769/mcp" },
    "gridData": { "w": 40, "h": 16 },
    "source": "Streamlit Demo"
  }
}
```

`src/test/fixtures/historical.fixture.json` — verbatim `.results[0:3]` of a live `GET https://openbb.example.ts.net/api/v1/equity/price/historical?symbol=AAPL&provider=eodhd&start_date=2026-07-01` response (captured 2026-07-30), wrapped in the real envelope shape:

```json
{
  "results": [
    { "date": "2026-07-01", "open": 293.44, "high": 296.59, "low": 289.2, "close": 294.38, "volume": 50164200, "adjusted_close": 294.38 },
    { "date": "2026-07-02", "open": 294.12, "high": 309.42, "low": 293.68, "close": 308.63, "volume": 75352800, "adjusted_close": 308.63 },
    { "date": "2026-07-06", "open": 307.36, "high": 314.2, "low": 307.0, "close": 312.66, "volume": 53590000, "adjusted_close": 312.66 }
  ],
  "provider": "eodhd"
}
```

- [ ] **Step 2: Write `src/lib/types.ts`** (types only, no test needed)

```ts
// ---- widgets.json protocol (normalized) ----

export type ParamType =
  | "date" | "text" | "ticker" | "number" | "boolean"
  | "endpoint" | "form" | "tabs";

export interface ParamOption {
  label: string;
  value: string | number | boolean;
}

export interface ParamDef {
  paramName: string;
  type: ParamType;
  value: string | number | boolean | null;
  label: string;
  description: string;
  /** false => control hidden, value still sent */
  show: boolean;
  /** normalized: raw multiSelect || multiple */
  multiSelect: boolean;
  options: ParamOption[] | null;
  optionsEndpoint: string | null;
  /** values may be "$otherParamName" references */
  optionsParams: Record<string, string> | null;
}

export type CellDataType =
  | "text" | "number" | "boolean" | "date" | "dateString" | "object";

export type FormatterFn =
  | "int" | "none" | "percent" | "normalized"
  | "normalizedPercent" | "dateToYear";

export interface ColumnDef {
  field: string;
  headerName?: string;
  headerTooltip?: string;
  cellDataType?: CellDataType;
  formatterFn?: FormatterFn | null;
  decimalPlaces?: number;
  prefix?: string;
  suffix?: string;
  hide?: boolean;
  pinned?: "left" | "right";
  width?: number;
  minWidth?: number;
  maxWidth?: number;
}

export interface GridData {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface WidgetDef {
  id: string;
  name: string;
  description: string;
  category: string;
  subCategory: string | null;
  /** "table" (default) | "chart" | "html" | "iframe" | "markdown" | "metric" | "multi_file_viewer" | "pdf" | anything else */
  type: string;
  /** normalized to a leading "/" — EXCEPT type === "iframe", where it is a full URL used verbatim as iframe src */
  endpoint: string;
  gridData: GridData;
  source: string[];
  runButton: boolean;
  /** widget supports ?raw=true raw-data view */
  raw: boolean;
  /** parsed but IGNORED in v1 (no refresh scheduling) */
  refetchInterval: number | string | false | null;
  params: ParamDef[];
  dataKey: string | null;
  columnsDefs: ColumnDef[] | null;
  /** storage.mcpUrl — MCP server to auto-connect while widget is on the active dashboard */
  mcpUrl: string | null;
}

// ---- app domain ----

export interface BackendConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** optional auth header applied to every request to this backend */
  headerName?: string;
  headerValue?: string;
}

export type ParamValues = Record<string, string | number | boolean | string[] | null>;

export interface CardLayout { x: number; y: number; w: number; h: number; }

export type CardView = "default" | "raw" | "chart";

export interface DashboardCard {
  uuid: string;
  widgetId: string;
  backendId: string;
  layout: CardLayout;
  params: ParamValues;
  view: CardView;
}

export interface Dashboard {
  id: string;
  name: string;
  cards: DashboardCard[];
}

export interface McpServerConfig {
  id: string;
  url: string;
  enabled: boolean;
}

export interface Settings {
  ritaUrl: string;
  theme: "dark";
  contextSharing: boolean;
  mcpServers: McpServerConfig[];
}
```

- [ ] **Step 3: Write the failing parser test** — `src/lib/widgets.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fixtures from "../test/fixtures/widgets.fixture.json";
import { parseWidgetEntry, parseWidgetsJson } from "./widgets";

describe("parseWidgetsJson", () => {
  const widgets = parseWidgetsJson(fixtures);
  const byId = Object.fromEntries(widgets.map((w) => [w.id, w]));

  it("parses all four fixture entries", () => {
    expect(widgets).toHaveLength(4);
    expect(Object.keys(byId).sort()).toEqual([
      "equity_price_historical_eodhd_obb",
      "equity_price_historical_eodhd_obb_chart",
      "imf_utils_presentation_table_custom_obb",
      "portfolio_iframe",
    ]);
  });

  it("normalizes the table widget", () => {
    const w = byId["equity_price_historical_eodhd_obb"];
    expect(w.type).toBe("table");
    expect(w.endpoint).toBe("/api/v1/equity/price/historical");
    expect(w.dataKey).toBe("results");
    expect(w.source).toEqual(["Eodhd"]);
    expect(w.gridData).toEqual({ w: 40, h: 15 });
    expect(w.columnsDefs).toHaveLength(8);
    expect(w.columnsDefs![0]).toMatchObject({
      field: "date",
      pinned: "left",
      cellDataType: "date",
    });
    const symbol = w.params.find((p) => p.paramName === "symbol")!;
    expect(symbol.multiSelect).toBe(true); // multiSelect || multiple
    expect(symbol.show).toBe(true);
    const interval = w.params.find((p) => p.paramName === "interval")!;
    expect(interval.options).toHaveLength(6);
    expect(interval.options![3]).toEqual({ label: "1d", value: "1d" });
    const provider = w.params.find((p) => p.paramName === "provider")!;
    expect(provider.show).toBe(false); // hidden but still sent
    expect(provider.value).toBe("eodhd");
    expect(provider.type).toBe("text"); // type defaults to text
    expect(provider.label).toBe("provider"); // label defaults to paramName
  });

  it("normalizes the html widget", () => {
    const w = byId["imf_utils_presentation_table_custom_obb"];
    expect(w.type).toBe("html");
    expect(w.raw).toBe(true);
    expect(w.refetchInterval).toBe(false);
    expect(w.dataKey).toBeNull(); // empty-string dataKey -> null
    const table = w.params.find((p) => p.paramName === "table")!;
    expect(table.type).toBe("endpoint");
    expect(table.optionsEndpoint).toBe("/api/v1/imf_utils/presentation_table_choices");
    expect(table.optionsParams).toEqual({ dataflow_group: "$dataflow_group" });
  });

  it("normalizes the chart widget", () => {
    const w = byId["equity_price_historical_eodhd_obb_chart"];
    expect(w.type).toBe("chart");
    expect(w.dataKey).toBe("chart.content");
    const chartParam = w.params.find((p) => p.paramName === "chart")!;
    expect(chartParam.show).toBe(false);
    expect(chartParam.value).toBe(true);
  });

  it("keeps iframe endpoint verbatim and extracts mcpUrl", () => {
    const w = byId["portfolio_iframe"];
    expect(w.type).toBe("iframe");
    expect(w.endpoint).toBe("http://localhost:8501"); // NOT slash-normalized
    expect(w.mcpUrl).toBe("http://localhost:7769/mcp");
    expect(w.source).toEqual(["Streamlit Demo"]); // string -> array
    expect(w.raw).toBe(false);
    expect(w.columnsDefs).toBeNull();
  });

  it("returns [] for non-object input", () => {
    expect(parseWidgetsJson(null)).toEqual([]);
    expect(parseWidgetsJson([1, 2])).toEqual([]);
    expect(parseWidgetsJson("nope")).toEqual([]);
  });
});

describe("parseWidgetEntry defaults", () => {
  it("applies protocol defaults for a minimal entry", () => {
    const w = parseWidgetEntry("min_widget", {
      name: "Minimal",
      endpoint: "api/no/leading/slash",
    });
    expect(w.type).toBe("table"); // type defaults to table
    expect(w.endpoint).toBe("/api/no/leading/slash"); // leading slash added
    expect(w.category).toBe("Other");
    expect(w.subCategory).toBeNull();
    expect(w.source).toEqual([]);
    expect(w.runButton).toBe(false);
    expect(w.raw).toBe(false);
    expect(w.refetchInterval).toBeNull();
    expect(w.params).toEqual([]);
    expect(w.gridData).toEqual({ w: 20, h: 12 }); // fallback size
    expect(w.dataKey).toBeNull();
    expect(w.mcpUrl).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/widgets.test.ts`
Expected: FAIL — `Cannot find module './widgets'` (or "Failed to resolve import").
Note: importing `.json` needs `"resolveJsonModule": true` — the Tauri react-ts scaffold's `tsconfig.json` already sets `"moduleResolution": "bundler"` which allows it; if `tsc` complains later, add `"resolveJsonModule": true` to `compilerOptions`.

- [ ] **Step 5: Implement `src/lib/widgets.ts`**

```ts
import type {
  ColumnDef, GridData, ParamDef, ParamOption, ParamType, WidgetDef,
} from "./types";

const PARAM_TYPES: ParamType[] = [
  "date", "text", "ticker", "number", "boolean", "endpoint", "form", "tabs",
];

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function parseParam(raw: Record<string, unknown>): ParamDef | null {
  const paramName = typeof raw.paramName === "string" ? raw.paramName : null;
  if (!paramName) return null;
  const rawType = typeof raw.type === "string" ? raw.type : "text";
  const type: ParamType = (PARAM_TYPES as string[]).includes(rawType)
    ? (rawType as ParamType)
    : "text";
  let options: ParamOption[] | null = null;
  if (Array.isArray(raw.options)) {
    options = raw.options
      .map((o) => asRecord(o))
      .filter((o): o is Record<string, unknown> => o !== null)
      .map((o) => ({
        label: String(o.label ?? o.value ?? ""),
        value: (o.value ?? "") as string | number | boolean,
      }));
  }
  const optionsParams = asRecord(raw.optionsParams);
  return {
    paramName,
    type,
    value: (raw.value ?? null) as ParamDef["value"],
    label: typeof raw.label === "string" ? raw.label : paramName,
    description: typeof raw.description === "string" ? raw.description : "",
    show: raw.show !== false,
    multiSelect: raw.multiSelect === true || raw.multiple === true,
    options,
    optionsEndpoint:
      typeof raw.optionsEndpoint === "string" ? raw.optionsEndpoint : null,
    optionsParams: optionsParams
      ? (Object.fromEntries(
          Object.entries(optionsParams).map(([k, v]) => [k, String(v)])
        ) as Record<string, string>)
      : null,
  };
}

export function parseWidgetEntry(
  id: string,
  raw: Record<string, unknown>
): WidgetDef {
  const type = typeof raw.type === "string" && raw.type !== "" ? raw.type : "table";
  let endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  if (type !== "iframe" && endpoint !== "" && !endpoint.startsWith("/")) {
    endpoint = `/${endpoint}`;
  }
  const source =
    typeof raw.source === "string"
      ? [raw.source]
      : Array.isArray(raw.source)
        ? raw.source.map((s) => String(s))
        : [];
  const gridRaw = asRecord(raw.gridData);
  const gridData: GridData = {
    w: typeof gridRaw?.w === "number" ? gridRaw.w : 20,
    h: typeof gridRaw?.h === "number" ? gridRaw.h : 12,
    ...(typeof gridRaw?.minW === "number" ? { minW: gridRaw.minW } : {}),
    ...(typeof gridRaw?.minH === "number" ? { minH: gridRaw.minH } : {}),
    ...(typeof gridRaw?.maxW === "number" ? { maxW: gridRaw.maxW } : {}),
    ...(typeof gridRaw?.maxH === "number" ? { maxH: gridRaw.maxH } : {}),
  };
  const data = asRecord(raw.data);
  const dataKeyRaw = typeof data?.dataKey === "string" ? data.dataKey : "";
  const table = asRecord(data?.table);
  const columnsDefs = Array.isArray(table?.columnsDefs)
    ? (table!.columnsDefs as ColumnDef[])
    : null;
  const storage = asRecord(raw.storage);
  const params = Array.isArray(raw.params)
    ? raw.params
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => p !== null)
        .map(parseParam)
        .filter((p): p is ParamDef => p !== null)
    : [];
  const refetch = raw.refetchInterval;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    description: typeof raw.description === "string" ? raw.description : "",
    category: typeof raw.category === "string" ? raw.category : "Other",
    subCategory:
      typeof raw.subCategory === "string" ? raw.subCategory : null,
    type,
    endpoint,
    gridData,
    source,
    runButton: raw.runButton === true,
    raw: raw.raw === true,
    refetchInterval:
      typeof refetch === "number" || typeof refetch === "string" || refetch === false
        ? refetch
        : null,
    params,
    dataKey: dataKeyRaw === "" ? null : dataKeyRaw,
    columnsDefs,
    mcpUrl: typeof storage?.mcpUrl === "string" ? storage.mcpUrl : null,
  };
}

export function parseWidgetsJson(json: unknown): WidgetDef[] {
  const obj = asRecord(json);
  if (!obj) return [];
  const out: WidgetDef[] = [];
  for (const [id, entry] of Object.entries(obj)) {
    const rec = asRecord(entry);
    if (rec) out.push(parseWidgetEntry(id, rec));
  }
  return out;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/widgets.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
cd $REPO_ROOT
git add src/lib/types.ts src/lib/widgets.ts src/lib/widgets.test.ts src/test/fixtures/
git commit -m "feat: widgets.json parser with normalized WidgetDef types and live NAS fixtures"
```

---
### Task 3: Widget data client (URL building, dataKey extraction, fetch) + mock backend server

**Files:**
- Create: `$REPO_ROOT/src/lib/dataClient.ts`
- Create: `$REPO_ROOT/src/test/mockServer.ts`
- Test: `$REPO_ROOT/src/lib/dataClient.test.ts`

**Interfaces:**
- Consumes: `WidgetDef`, `BackendConfig`, `ParamValues` from `src/lib/types.ts`; `parseWidgetsJson` from `src/lib/widgets.ts` (Task 2).
- Produces (used by Tasks 8, 9, 10, 11, 12, 14, 17):
  - `class HttpError extends Error { status: number; url: string }`
  - `serializeParams(values: ParamValues): Record<string, string>`
  - `buildWidgetUrl(backend: BackendConfig, widget: WidgetDef, values: ParamValues, opts?: { raw?: boolean; theme?: "dark" | "light" }): string`
  - `extractData(json: unknown, dataKey: string | null): unknown`
  - `fetchJson(url: string, backend?: BackendConfig, fetchImpl?: typeof fetch): Promise<unknown>`
  - `fetchText(url: string, backend?: BackendConfig, fetchImpl?: typeof fetch): Promise<string>`
  - `fetchWidgetData(backend: BackendConfig, widget: WidgetDef, values: ParamValues, opts?: { raw?: boolean; theme?: "dark" | "light" }, fetchImpl?: typeof fetch): Promise<unknown>`
  - `fetchWidgetHtml(backend: BackendConfig, widget: WidgetDef, values: ParamValues, fetchImpl?: typeof fetch): Promise<string>`
  - `fetchWidgetsJson(backend: BackendConfig, fetchImpl?: typeof fetch): Promise<WidgetDef[]>`
  - From `src/test/mockServer.ts` (tests only): `startMockBackend(): Promise<MockBackend>` where `MockBackend = { url: string; requests: { url: string; headers: Record<string, string> }[]; close(): Promise<void> }`

- [ ] **Step 1: Write the failing test** — `src/lib/dataClient.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendConfig, WidgetDef } from "./types";
import {
  HttpError, buildWidgetUrl, extractData, fetchWidgetData,
  fetchWidgetsJson, serializeParams,
} from "./dataClient";
import { startMockBackend, type MockBackend } from "../test/mockServer";
import fixtures from "../test/fixtures/widgets.fixture.json";
import historical from "../test/fixtures/historical.fixture.json";
import { parseWidgetsJson } from "./widgets";

// Route plugin-http through Node's fetch so the mock server works in tests.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

const widgets = parseWidgetsJson(fixtures);
const tableWidget = widgets.find((w) => w.id === "equity_price_historical_eodhd_obb")!;
const chartWidget = widgets.find((w) => w.id === "equity_price_historical_eodhd_obb_chart")!;
const htmlWidget = widgets.find((w) => w.id === "imf_utils_presentation_table_custom_obb")!;
const iframeWidget = widgets.find((w) => w.id === "portfolio_iframe")!;

const backend: BackendConfig = {
  id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net",
};

describe("serializeParams", () => {
  it("joins arrays with commas, stringifies booleans, drops empties", () => {
    expect(
      serializeParams({
        symbol: ["AAPL", "MSFT"], chart: true, raw: false,
        limit: 3, note: "", missing: null,
      })
    ).toEqual({ symbol: "AAPL,MSFT", chart: "true", raw: "false", limit: "3" });
  });
});

describe("buildWidgetUrl", () => {
  it("builds a GET url with query params", () => {
    const url = buildWidgetUrl(backend, tableWidget, {
      symbol: "AAPL", provider: "eodhd", start_date: "2026-07-01",
    });
    expect(url).toBe(
      "https://openbb.example.ts.net/api/v1/equity/price/historical?symbol=AAPL&provider=eodhd&start_date=2026-07-01"
    );
  });

  it("adds theme to chart and html widgets only", () => {
    expect(buildWidgetUrl(backend, chartWidget, {}, { theme: "dark" })).toContain("theme=dark");
    expect(buildWidgetUrl(backend, htmlWidget, {}, { theme: "dark" })).toContain("theme=dark");
    expect(buildWidgetUrl(backend, tableWidget, {}, { theme: "dark" })).not.toContain("theme");
  });

  it("never themes iframe widgets and uses their endpoint verbatim", () => {
    const url = buildWidgetUrl(backend, iframeWidget, {}, { theme: "dark" });
    expect(url).toBe("http://localhost:8501/");
  });

  it("adds raw=true when the raw view is toggled", () => {
    expect(buildWidgetUrl(backend, htmlWidget, {}, { raw: true })).toContain("raw=true");
  });
});

describe("extractData", () => {
  it("passes arrays through untouched", () => {
    expect(extractData([1, 2], "results")).toEqual([1, 2]);
  });
  it("extracts a top-level dataKey", () => {
    expect(extractData(historical, "results")).toEqual(historical.results);
  });
  it("extracts a dotted dataKey path", () => {
    const resp = { chart: { content: { data: [], layout: {} } } };
    expect(extractData(resp, "chart.content")).toEqual({ data: [], layout: {} });
  });
  it("returns input unchanged when dataKey is null or path missing", () => {
    expect(extractData({ a: 1 }, null)).toEqual({ a: 1 });
    expect(extractData({ a: 1 }, "nope.deep")).toEqual({ a: 1 });
  });
});

describe("against the mock backend", () => {
  let mock: MockBackend;
  let mockBackendCfg: BackendConfig;
  beforeAll(async () => {
    mock = await startMockBackend();
    mockBackendCfg = {
      id: "mock", name: "Mock", baseUrl: mock.url,
      headerName: "X-API-KEY", headerValue: "secret123",
    };
  });
  afterAll(async () => { await mock.close(); });

  it("fetches and parses widgets.json", async () => {
    const defs = await fetchWidgetsJson(mockBackendCfg);
    expect(defs).toHaveLength(4);
  });

  it("fetches widget data, applies dataKey, sends the auth header", async () => {
    const data = await fetchWidgetData(mockBackendCfg, tableWidget, {
      symbol: ["AAPL", "MSFT"], provider: "eodhd",
    });
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(3);
    const last = mock.requests[mock.requests.length - 1];
    expect(last.url).toContain("symbol=AAPL%2CMSFT");
    expect(last.headers["x-api-key"]).toBe("secret123");
  });

  it("throws HttpError with status and url on non-2xx", async () => {
    const boom: WidgetDef = { ...tableWidget, endpoint: "/boom", dataKey: null };
    await expect(fetchWidgetData(mockBackendCfg, boom, {})).rejects.toThrowError(HttpError);
    await expect(fetchWidgetData(mockBackendCfg, boom, {})).rejects.toMatchObject({ status: 500 });
  });
});
```

- [ ] **Step 2: Write `src/test/mockServer.ts`** (test helper; also serves the integration role the spec asks for — canned widgets.json + data, no live NAS)

```ts
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const widgetsJson = readFileSync(path.join(here, "fixtures/widgets.fixture.json"), "utf8");
const historicalJson = readFileSync(path.join(here, "fixtures/historical.fixture.json"), "utf8");

export interface MockBackend {
  url: string;
  requests: { url: string; headers: Record<string, string> }[];
  close(): Promise<void>;
}

export function startMockBackend(): Promise<MockBackend> {
  const requests: MockBackend["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({
      url: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
    });
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname === "/widgets.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(widgetsJson);
    } else if (u.pathname === "/api/v1/equity/price/historical") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(historicalJson);
    } else if (u.pathname === "/api/v1/imf_utils/presentation_table") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h1>IMF</h1><script>document.title='ok'</script></body></html>");
    } else if (u.pathname === "/boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"detail":"kaboom"}');
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/dataClient.test.ts`
Expected: FAIL — `Cannot find module './dataClient'`.

- [ ] **Step 4: Implement `src/lib/dataClient.ts`**

```ts
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, ParamValues, WidgetDef } from "./types";
import { parseWidgetsJson } from "./widgets";

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export function serializeParams(values: ParamValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v.join(","); // multiSelect: comma-joined into ONE param
    } else if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
    } else {
      const s = String(v);
      if (s === "") continue;
      out[k] = s;
    }
  }
  return out;
}

export interface WidgetFetchOpts {
  raw?: boolean;
  theme?: "dark" | "light";
}

export function buildWidgetUrl(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  opts: WidgetFetchOpts = {}
): string {
  // iframe endpoints are full URLs used verbatim (no params, no theme)
  const url =
    widget.type === "iframe"
      ? new URL(widget.endpoint)
      : new URL(widget.endpoint, backend.baseUrl);
  if (widget.type === "iframe") return url.toString();
  for (const [k, v] of Object.entries(serializeParams(values))) {
    url.searchParams.set(k, v);
  }
  if (opts.theme && (widget.type === "chart" || widget.type === "html")) {
    url.searchParams.set("theme", opts.theme);
  }
  if (opts.raw) url.searchParams.set("raw", "true");
  return url.toString();
}

export function extractData(json: unknown, dataKey: string | null): unknown {
  if (Array.isArray(json)) return json;
  if (dataKey === null) return json;
  let cur: unknown = json;
  for (const part of dataKey.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) {
      return json; // path missing -> caller falls back to raw JSON view
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function authHeaders(backend?: BackendConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (backend?.headerName && backend.headerValue) {
    h[backend.headerName] = backend.headerValue;
  }
  return h;
}

async function doFetch(
  url: string,
  accept: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch
): Promise<Response> {
  const res = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: accept, ...authHeaders(backend) },
  });
  if (!res.ok) {
    throw new HttpError(res.status, url, await res.text().catch(() => ""));
  }
  return res;
}

export async function fetchJson(
  url: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch
): Promise<unknown> {
  const res = await doFetch(url, "application/json", backend, fetchImpl);
  return res.json();
}

export async function fetchText(
  url: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch
): Promise<string> {
  const res = await doFetch(url, "text/html, text/plain, */*", backend, fetchImpl);
  return res.text();
}

export async function fetchWidgetData(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  opts: WidgetFetchOpts = {},
  fetchImpl: typeof fetch = tauriFetch
): Promise<unknown> {
  const url = buildWidgetUrl(backend, widget, values, opts);
  const json = await fetchJson(url, backend, fetchImpl);
  // raw view: response is plain records, dataKey does not apply
  return extractData(json, opts.raw ? null : widget.dataKey);
}

export async function fetchWidgetHtml(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  fetchImpl: typeof fetch = tauriFetch
): Promise<string> {
  const url = buildWidgetUrl(backend, widget, values, { theme: "dark" });
  return fetchText(url, backend, fetchImpl);
}

export async function fetchWidgetsJson(
  backend: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch
): Promise<WidgetDef[]> {
  const base = backend.baseUrl.replace(/\/+$/, "");
  const json = await fetchJson(`${base}/widgets.json`, backend, fetchImpl);
  return parseWidgetsJson(json);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/dataClient.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT
git add src/lib/dataClient.ts src/lib/dataClient.test.ts src/test/mockServer.ts
git commit -m "feat: widget data client with URL building, dataKey extraction, auth headers, mock backend"
```

---

### Task 4: Persistence ($APPDATA JSON files) and rotating logger

**Files:**
- Create: `$REPO_ROOT/src/lib/persistence.ts`
- Create: `$REPO_ROOT/src/lib/logger.ts`
- Create: `$REPO_ROOT/src/test/memfs.ts`
- Test: `$REPO_ROOT/src/lib/persistence.test.ts`
- Test: `$REPO_ROOT/src/lib/logger.test.ts`

**Interfaces:**
- Consumes: `Settings`, `BackendConfig`, `Dashboard` from `src/lib/types.ts`.
- Produces (used by Tasks 5, 10, 12, 15, 16, 17):
  - persistence: `DEFAULT_SETTINGS: Settings`, `DEFAULT_BACKENDS: BackendConfig[]`, `loadSettings(): Promise<Settings>`, `saveSettings(s: Settings): Promise<void>`, `loadBackends(): Promise<BackendConfig[]>`, `saveBackends(b: BackendConfig[]): Promise<void>`, `loadDashboards(): Promise<Dashboard[]>`, `saveDashboard(d: Dashboard): Promise<void>`, `deleteDashboard(id: string): Promise<void>`
  - logger: `LOG_FILE = "logs/openbb-desk.log"`, `logLine(level: "INFO" | "ERROR", message: string): Promise<void>`, `logInfo(message: string): void`, `logError(message: string): void`, `logOnce(key: string, message: string): void`, `readLogTail(maxLines: number): Promise<string[]>`, `getLogPath(): Promise<string>`
  - test helper `src/test/memfs.ts`: in-memory `@tauri-apps/plugin-fs` replacement — exports `files: Map<string, string>`, `dirs: Set<string>`, `resetFs(): void`, plus `BaseDirectory, exists, mkdir, readTextFile, writeTextFile, readDir, remove, rename, stat` mirroring the plugin API.

Persisted layout (all under `$APPDATA` = `~/Library/Application Support/com.<owner>.openbb-desk/` on macOS):
- `settings.json` — `Settings`, seeded `{ ritaUrl: "http://agent-host:8002", theme: "dark", contextSharing: true, mcpServers: [openbb-mcp 8443, stores-mcp 8444] }`
- `backends.json` — `BackendConfig[]`, seeded `[{ id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net" }]`
- `dashboards/<uuid>.json` — one `Dashboard` per file (plain files the user can back up)
- `logs/openbb-desk.log` (+ `.1` after rotation at 1 MB)

- [ ] **Step 1: Write `src/test/memfs.ts`**

```ts
// In-memory stand-in for @tauri-apps/plugin-fs, installed via vi.mock in tests.
export const files = new Map<string, string>();
export const dirs = new Set<string>();
export function resetFs(): void { files.clear(); dirs.clear(); }

export const BaseDirectory = { AppData: 21 } as const;
type Opts = { baseDir?: number; recursive?: boolean; append?: boolean } | undefined;

export async function exists(path: string, _o?: Opts): Promise<boolean> {
  if (files.has(path) || dirs.has(path)) return true;
  const prefix = path.replace(/\/$/, "") + "/";
  for (const k of files.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

export async function mkdir(path: string, _o?: Opts): Promise<void> {
  dirs.add(path);
}

export async function readTextFile(path: string, _o?: Opts): Promise<string> {
  const v = files.get(path);
  if (v === undefined) throw new Error(`memfs: no such file: ${path}`);
  return v;
}

export async function writeTextFile(
  path: string, contents: string, o?: Opts
): Promise<void> {
  if (o?.append && files.has(path)) files.set(path, files.get(path)! + contents);
  else files.set(path, contents);
}

export async function readDir(
  path: string, _o?: Opts
): Promise<{ name: string; isFile: boolean }[]> {
  const prefix = path.replace(/\/$/, "") + "/";
  const names = new Set<string>();
  for (const k of files.keys()) {
    if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
  }
  return [...names].map((name) => ({ name, isFile: files.has(prefix + name) }));
}

export async function remove(path: string, _o?: Opts): Promise<void> {
  files.delete(path);
  dirs.delete(path);
}

export async function rename(
  oldPath: string, newPath: string, _o?: unknown
): Promise<void> {
  const v = files.get(oldPath);
  if (v === undefined) throw new Error(`memfs: no such file: ${oldPath}`);
  files.set(newPath, v);
  files.delete(oldPath);
}

export async function stat(path: string, _o?: Opts): Promise<{ size: number }> {
  const v = files.get(path);
  if (v === undefined) throw new Error(`memfs: no such file: ${path}`);
  return { size: new TextEncoder().encode(v).length };
}
```

- [ ] **Step 2: Write the failing persistence test** — `src/lib/persistence.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFs } from "../test/memfs";
import type { Dashboard } from "./types";

vi.mock("@tauri-apps/plugin-fs", () => import("../test/memfs"));

import {
  DEFAULT_BACKENDS, DEFAULT_SETTINGS, deleteDashboard, loadBackends,
  loadDashboards, loadSettings, saveDashboard, saveSettings,
} from "./persistence";

beforeEach(() => resetFs());

describe("settings", () => {
  it("seeds defaults on first run and writes settings.json", async () => {
    const s = await loadSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.ritaUrl).toBe("http://agent-host:8002");
    expect(s.mcpServers.map((m) => m.url)).toEqual([
      "https://openbb.example.ts.net:8443/mcp/",
      "https://openbb.example.ts.net:8444/mcp/",
    ]);
    expect(files.has("settings.json")).toBe(true);
  });

  it("round-trips saved settings and fills missing keys from defaults", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, contextSharing: false });
    expect((await loadSettings()).contextSharing).toBe(false);
    files.set("settings.json", JSON.stringify({ ritaUrl: "http://other:9" }));
    const merged = await loadSettings();
    expect(merged.ritaUrl).toBe("http://other:9");
    expect(merged.mcpServers).toHaveLength(2); // filled from defaults
  });
});

describe("backends", () => {
  it("seeds the NAS backend on first run", async () => {
    const b = await loadBackends();
    expect(b).toEqual(DEFAULT_BACKENDS);
    expect(b[0]).toEqual({
      id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net",
    });
  });
});

describe("dashboards", () => {
  it("seeds one empty Main dashboard on first run", async () => {
    const ds = await loadDashboards();
    expect(ds).toHaveLength(1);
    expect(ds[0].name).toBe("Main");
    expect(ds[0].cards).toEqual([]);
    expect(files.has(`dashboards/${ds[0].id}.json`)).toBe(true);
  });

  it("round-trips one file per dashboard and deletes", async () => {
    const d: Dashboard = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Equities",
      cards: [{
        uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        widgetId: "equity_price_historical_eodhd_obb",
        backendId: "nas",
        layout: { x: 0, y: 0, w: 40, h: 15 },
        params: { symbol: "AAPL" },
        view: "default",
      }],
    };
    await saveDashboard(d);
    const loaded = await loadDashboards();
    expect(loaded.find((x) => x.id === d.id)).toEqual(d);
    await deleteDashboard(d.id);
    expect(files.has(`dashboards/${d.id}.json`)).toBe(false);
  });

  it("skips corrupt dashboard files instead of crashing", async () => {
    files.set("dashboards/bad.json", "{not json");
    const ds = await loadDashboards();
    expect(ds.every((d) => typeof d.id === "string")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/lib/persistence.test.ts`
Expected: FAIL — `Cannot find module './persistence'`.

- [ ] **Step 4: Implement `src/lib/persistence.ts`**

```ts
import {
  BaseDirectory, exists, mkdir, readDir, readTextFile, remove, writeTextFile,
} from "@tauri-apps/plugin-fs";
import type { BackendConfig, Dashboard, Settings } from "./types";

const BASE = { baseDir: BaseDirectory.AppData };

export const DEFAULT_SETTINGS: Settings = {
  ritaUrl: "http://agent-host:8002",
  theme: "dark",
  contextSharing: true,
  mcpServers: [
    { id: "openbb-mcp", url: "https://openbb.example.ts.net:8443/mcp/", enabled: true },
    { id: "stores-mcp", url: "https://openbb.example.ts.net:8444/mcp/", enabled: true },
  ],
};

export const DEFAULT_BACKENDS: BackendConfig[] = [
  { id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net" },
];

async function ensureDirs(): Promise<void> {
  await mkdir("dashboards", { ...BASE, recursive: true });
  await mkdir("logs", { ...BASE, recursive: true });
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!(await exists(path, BASE))) return null;
  try {
    return JSON.parse(await readTextFile(path, BASE)) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, JSON.stringify(value, null, 2), BASE);
}

export async function loadSettings(): Promise<Settings> {
  await ensureDirs();
  const s = await readJsonFile<Partial<Settings>>("settings.json");
  if (s === null) {
    await writeJsonFile("settings.json", DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
  return { ...structuredClone(DEFAULT_SETTINGS), ...s } as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureDirs();
  await writeJsonFile("settings.json", settings);
}

export async function loadBackends(): Promise<BackendConfig[]> {
  await ensureDirs();
  const b = await readJsonFile<BackendConfig[]>("backends.json");
  if (!Array.isArray(b) || b.length === 0) {
    await writeJsonFile("backends.json", DEFAULT_BACKENDS);
    return structuredClone(DEFAULT_BACKENDS);
  }
  return b;
}

export async function saveBackends(backends: BackendConfig[]): Promise<void> {
  await ensureDirs();
  await writeJsonFile("backends.json", backends);
}

export async function loadDashboards(): Promise<Dashboard[]> {
  await ensureDirs();
  const entries = await readDir("dashboards", BASE);
  const out: Dashboard[] = [];
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(".json")) continue;
    const d = await readJsonFile<Dashboard>(`dashboards/${e.name}`);
    if (d && typeof d.id === "string" && Array.isArray(d.cards)) out.push(d);
  }
  if (out.length === 0) {
    const main: Dashboard = { id: crypto.randomUUID(), name: "Main", cards: [] };
    await saveDashboard(main);
    return [main];
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function saveDashboard(d: Dashboard): Promise<void> {
  await ensureDirs();
  await writeJsonFile(`dashboards/${d.id}.json`, d);
}

export async function deleteDashboard(id: string): Promise<void> {
  await remove(`dashboards/${id}.json`, BASE);
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/lib/persistence.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write the failing logger test** — `src/lib/logger.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFs } from "../test/memfs";

vi.mock("@tauri-apps/plugin-fs", () => import("../test/memfs"));

import { LOG_FILE, logError, logLine, logOnce, readLogTail } from "./logger";

beforeEach(() => resetFs());

describe("logger", () => {
  it("appends timestamped lines", async () => {
    await logLine("INFO", "hello");
    await logLine("ERROR", "world");
    const text = files.get(LOG_FILE)!;
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.*\[INFO\] hello$/);
    expect(lines[1]).toMatch(/\[ERROR\] world$/);
  });

  it("rotates to .1 at 1MB by rename", async () => {
    files.set(LOG_FILE, "x".repeat(1024 * 1024));
    await logLine("INFO", "after rotation");
    expect(files.get(`${LOG_FILE}.1`)).toHaveLength(1024 * 1024);
    expect(files.get(LOG_FILE)).toMatch(/after rotation/);
  });

  it("replaces an existing .1 on the next rotation", async () => {
    files.set(`${LOG_FILE}.1`, "old");
    files.set(LOG_FILE, "y".repeat(1024 * 1024));
    await logLine("INFO", "again");
    expect(files.get(`${LOG_FILE}.1`)).toBe("y".repeat(1024 * 1024));
  });

  it("readLogTail returns the last N lines", async () => {
    for (let i = 0; i < 10; i++) await logLine("INFO", `line ${i}`);
    const tail = await readLogTail(3);
    expect(tail).toHaveLength(3);
    expect(tail[2]).toMatch(/line 9$/);
  });

  it("logOnce only writes once per key; logError is fire-and-forget", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logOnce("k1", "only once");
    logOnce("k1", "only once");
    logError("boom");
    await logLine("INFO", "flush"); // logger serializes writes; this awaits the queue
    const text = files.get(LOG_FILE)!;
    expect(text.match(/only once/g)).toHaveLength(1);
    expect(text).toMatch(/boom/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm vitest run src/lib/logger.test.ts`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 8: Implement `src/lib/logger.ts`**

```ts
import {
  BaseDirectory, exists, mkdir, readTextFile, remove, rename, stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const BASE = { baseDir: BaseDirectory.AppData };
export const LOG_FILE = "logs/openbb-desk.log";
const ROTATED = `${LOG_FILE}.1`;
const MAX_BYTES = 1024 * 1024; // 1MB

// Serialize writes so concurrent log calls never interleave a rotation.
let queue: Promise<void> = Promise.resolve();

async function rotateIfNeeded(): Promise<void> {
  if (!(await exists(LOG_FILE, BASE))) return;
  const info = await stat(LOG_FILE, BASE);
  if (info.size < MAX_BYTES) return;
  if (await exists(ROTATED, BASE)) await remove(ROTATED, BASE);
  await rename(LOG_FILE, ROTATED, {
    oldPathBaseDir: BaseDirectory.AppData,
    newPathBaseDir: BaseDirectory.AppData,
  });
}

export function logLine(level: "INFO" | "ERROR", message: string): Promise<void> {
  queue = queue.then(async () => {
    try {
      await mkdir("logs", { ...BASE, recursive: true });
      await rotateIfNeeded();
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      await writeTextFile(LOG_FILE, line, { ...BASE, append: true });
    } catch (e) {
      // Logging must never take the app down.
      console.error("logger write failed:", e);
    }
  });
  return queue;
}

export function logInfo(message: string): void {
  console.info(message);
  void logLine("INFO", message);
}

export function logError(message: string): void {
  console.error(message);
  void logLine("ERROR", message);
}

const seen = new Set<string>();
export function logOnce(key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  logError(message);
}

export async function readLogTail(maxLines: number): Promise<string[]> {
  if (!(await exists(LOG_FILE, BASE))) return [];
  const text = await readTextFile(LOG_FILE, BASE);
  return text.split("\n").filter((l) => l !== "").slice(-maxLines);
}

/** Absolute path for display in the Settings dialog. */
export async function getLogPath(): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return join(await appDataDir(), LOG_FILE);
}
```

(`getLogPath` uses a dynamic import so the module stays importable in vitest without the Tauri runtime.)

- [ ] **Step 9: Run to verify it passes**

Run: `pnpm vitest run src/lib/logger.test.ts`
Expected: PASS (5 tests). Then run the whole suite: `pnpm vitest run` — everything green.

- [ ] **Step 10: Commit**

```bash
cd $REPO_ROOT
git add src/lib/persistence.ts src/lib/logger.ts src/lib/persistence.test.ts src/lib/logger.test.ts src/test/memfs.ts
git commit -m "feat: APPDATA JSON persistence with seeded defaults and 1MB-rotating file logger"
```

---
### Task 5: Zustand stores (settings, backends, widget registry, dashboards)

**Files:**
- Create: `$REPO_ROOT/src/stores/settingsStore.ts`
- Create: `$REPO_ROOT/src/stores/backendsStore.ts`
- Create: `$REPO_ROOT/src/stores/registryStore.ts`
- Create: `$REPO_ROOT/src/stores/dashboardStore.ts`
- Test: `$REPO_ROOT/src/stores/dashboardStore.test.ts`
- Test: `$REPO_ROOT/src/stores/registryStore.test.ts`

**Interfaces:**
- Consumes: types from Task 2; `loadSettings/saveSettings/loadBackends/saveBackends/loadDashboards/saveDashboard/deleteDashboard` (Task 4); `fetchWidgetsJson` (Task 3); `logError` (Task 4).
- Produces (used by every UI task):
  - `useSettingsStore` state: `{ settings: Settings | null; load(): Promise<void>; update(patch: Partial<Settings>): Promise<void> }`
  - `useBackendsStore` state: `{ backends: BackendConfig[]; status: Record<string, BackendStatus>; load(): Promise<void>; save(backends: BackendConfig[]): Promise<void>; setStatus(id: string, status: BackendStatus): void }` with `type BackendStatus = "unknown" | "online" | "offline"`
  - `useRegistryStore` state: `{ widgets: Record<string, WidgetDef[]>; loading: boolean; refresh(backends: BackendConfig[]): Promise<void>; find(backendId: string, widgetId: string): WidgetDef | undefined }` (keyed by backendId; `refresh` marks each backend online/offline)
  - `useDashboardStore` state: `{ dashboards: Dashboard[]; activeId: string | null; load(): Promise<void>; setActive(id: string): void; active(): Dashboard | null; addDashboard(name: string): Promise<string>; renameDashboard(id: string, name: string): Promise<void>; removeDashboard(id: string): Promise<void>; addCard(widget: WidgetDef, backendId: string): Promise<void>; removeCard(uuid: string): Promise<void>; updateLayouts(layouts: { i: string; x: number; y: number; w: number; h: number }[]): Promise<void>; setCardParams(uuid: string, params: ParamValues): Promise<void>; setCardView(uuid: string, view: CardView): Promise<void> }`
  - Grid constants exported from `dashboardStore.ts`: `GRID_COLS = 60`, `GRID_ROW_HEIGHT = 24`

- [ ] **Step 1: Write the failing dashboard-store test** — `src/stores/dashboardStore.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard, WidgetDef } from "../lib/types";

const saveDashboard = vi.fn(async (_d: Dashboard) => {});
const deleteDashboard = vi.fn(async (_id: string) => {});
const loadDashboards = vi.fn(async (): Promise<Dashboard[]> => [
  { id: "dash-1", name: "Main", cards: [] },
]);

vi.mock("../lib/persistence", () => ({
  loadDashboards: (...a: []) => loadDashboards(...a),
  saveDashboard: (d: Dashboard) => saveDashboard(d),
  deleteDashboard: (id: string) => deleteDashboard(id),
}));

import { GRID_COLS, useDashboardStore } from "./dashboardStore";

const widget: WidgetDef = {
  id: "equity_price_historical_eodhd_obb", name: "Historical", description: "",
  category: "Equity", subCategory: "Price", type: "table",
  endpoint: "/api/v1/equity/price/historical",
  gridData: { w: 40, h: 15 }, source: ["Eodhd"], runButton: false, raw: false,
  refetchInterval: null, params: [], dataKey: "results", columnsDefs: null,
  mcpUrl: null,
};

beforeEach(async () => {
  vi.clearAllMocks();
  useDashboardStore.setState({ dashboards: [], activeId: null });
  await useDashboardStore.getState().load();
});

describe("useDashboardStore", () => {
  it("loads dashboards and activates the first", () => {
    const s = useDashboardStore.getState();
    expect(s.dashboards).toHaveLength(1);
    expect(s.activeId).toBe("dash-1");
    expect(s.active()?.name).toBe("Main");
  });

  it("adds a card sized from gridData clamped to the 60-col grid", async () => {
    await useDashboardStore.getState().addCard(widget, "nas");
    await useDashboardStore.getState().addCard({ ...widget, gridData: { w: 999, h: 2 } }, "nas");
    const cards = useDashboardStore.getState().active()!.cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].layout).toMatchObject({ x: 0, y: 0, w: 40, h: 15 });
    expect(cards[0].widgetId).toBe(widget.id);
    expect(cards[0].backendId).toBe("nas");
    expect(cards[0].view).toBe("default");
    expect(cards[0].uuid).toMatch(/[0-9a-f-]{36}/);
    expect(cards[1].layout.w).toBeLessThanOrEqual(GRID_COLS);
    expect(cards[1].layout.h).toBeGreaterThanOrEqual(3); // min height clamp
    expect(cards[1].layout.y).toBe(15); // placed below the first card
    expect(saveDashboard).toHaveBeenCalled();
  });

  it("chart-type widgets start in chart view", async () => {
    await useDashboardStore.getState().addCard({ ...widget, type: "chart" }, "nas");
    expect(useDashboardStore.getState().active()!.cards[0].view).toBe("chart");
  });

  it("removes cards, updates layouts and params, persists each change", async () => {
    await useDashboardStore.getState().addCard(widget, "nas");
    const uuid = useDashboardStore.getState().active()!.cards[0].uuid;
    await useDashboardStore.getState().updateLayouts([{ i: uuid, x: 5, y: 2, w: 30, h: 10 }]);
    expect(useDashboardStore.getState().active()!.cards[0].layout).toEqual({ x: 5, y: 2, w: 30, h: 10 });
    await useDashboardStore.getState().setCardParams(uuid, { symbol: "MSFT" });
    expect(useDashboardStore.getState().active()!.cards[0].params).toEqual({ symbol: "MSFT" });
    await useDashboardStore.getState().setCardView(uuid, "raw");
    expect(useDashboardStore.getState().active()!.cards[0].view).toBe("raw");
    await useDashboardStore.getState().removeCard(uuid);
    expect(useDashboardStore.getState().active()!.cards).toHaveLength(0);
    expect(saveDashboard.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("adds, renames, switches and removes dashboards", async () => {
    const id = await useDashboardStore.getState().addDashboard("Equities");
    expect(useDashboardStore.getState().activeId).toBe(id);
    await useDashboardStore.getState().renameDashboard(id, "Macro");
    expect(useDashboardStore.getState().dashboards.find((d) => d.id === id)!.name).toBe("Macro");
    useDashboardStore.getState().setActive("dash-1");
    expect(useDashboardStore.getState().activeId).toBe("dash-1");
    await useDashboardStore.getState().removeDashboard(id);
    expect(deleteDashboard).toHaveBeenCalledWith(id);
    expect(useDashboardStore.getState().dashboards).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Write the failing registry-store test** — `src/stores/registryStore.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, WidgetDef } from "../lib/types";

const fetchWidgetsJson = vi.fn();
vi.mock("../lib/dataClient", () => ({
  fetchWidgetsJson: (b: BackendConfig) => fetchWidgetsJson(b),
}));
vi.mock("../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

import { useBackendsStore } from "./backendsStore";
import { useRegistryStore } from "./registryStore";

const nas: BackendConfig = { id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net" };
const widget = { id: "w1", name: "W1" } as WidgetDef;

beforeEach(() => {
  vi.clearAllMocks();
  useRegistryStore.setState({ widgets: {}, loading: false });
  useBackendsStore.setState({ backends: [nas], status: {} });
});

describe("useRegistryStore.refresh", () => {
  it("stores widgets per backend and marks it online", async () => {
    fetchWidgetsJson.mockResolvedValueOnce([widget]);
    await useRegistryStore.getState().refresh([nas]);
    expect(useRegistryStore.getState().widgets.nas).toEqual([widget]);
    expect(useRegistryStore.getState().find("nas", "w1")).toEqual(widget);
    expect(useBackendsStore.getState().status.nas).toBe("online");
  });

  it("marks the backend offline on failure and keeps prior widgets", async () => {
    useRegistryStore.setState({ widgets: { nas: [widget] }, loading: false });
    fetchWidgetsJson.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await useRegistryStore.getState().refresh([nas]);
    expect(useBackendsStore.getState().status.nas).toBe("offline");
    expect(useRegistryStore.getState().widgets.nas).toEqual([widget]); // stale kept
    expect(useRegistryStore.getState().loading).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run src/stores`
Expected: FAIL — cannot find `./dashboardStore` / `./registryStore` / `./backendsStore`.

- [ ] **Step 4: Implement the four stores**

`src/stores/settingsStore.ts`:

```ts
import { create } from "zustand";
import type { Settings } from "../lib/types";
import { loadSettings, saveSettings } from "../lib/persistence";

interface SettingsState {
  settings: Settings | null;
  load(): Promise<void>;
  update(patch: Partial<Settings>): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  async load() {
    set({ settings: await loadSettings() });
  },
  async update(patch) {
    const cur = get().settings;
    if (!cur) return;
    const next = { ...cur, ...patch };
    set({ settings: next });
    await saveSettings(next);
  },
}));
```

`src/stores/backendsStore.ts`:

```ts
import { create } from "zustand";
import type { BackendConfig } from "../lib/types";
import { loadBackends, saveBackends } from "../lib/persistence";

export type BackendStatus = "unknown" | "online" | "offline";

interface BackendsState {
  backends: BackendConfig[];
  status: Record<string, BackendStatus>;
  load(): Promise<void>;
  save(backends: BackendConfig[]): Promise<void>;
  setStatus(id: string, status: BackendStatus): void;
}

export const useBackendsStore = create<BackendsState>((set, get) => ({
  backends: [],
  status: {},
  async load() {
    set({ backends: await loadBackends() });
  },
  async save(backends) {
    set({ backends });
    await saveBackends(backends);
  },
  setStatus(id, status) {
    set({ status: { ...get().status, [id]: status } });
  },
}));
```

`src/stores/registryStore.ts`:

```ts
import { create } from "zustand";
import type { BackendConfig, WidgetDef } from "../lib/types";
import { fetchWidgetsJson } from "../lib/dataClient";
import { logError } from "../lib/logger";
import { useBackendsStore } from "./backendsStore";

interface RegistryState {
  widgets: Record<string, WidgetDef[]>;
  loading: boolean;
  refresh(backends: BackendConfig[]): Promise<void>;
  find(backendId: string, widgetId: string): WidgetDef | undefined;
}

export const useRegistryStore = create<RegistryState>((set, get) => ({
  widgets: {},
  loading: false,
  async refresh(backends) {
    set({ loading: true });
    const next: Record<string, WidgetDef[]> = { ...get().widgets };
    for (const b of backends) {
      try {
        next[b.id] = await fetchWidgetsJson(b);
        useBackendsStore.getState().setStatus(b.id, "online");
      } catch (e) {
        logError(`widgets.json fetch failed for ${b.name} (${b.baseUrl}): ${String(e)}`);
        useBackendsStore.getState().setStatus(b.id, "offline");
        // keep whatever we already had for this backend
      }
    }
    set({ widgets: next, loading: false });
  },
  find(backendId, widgetId) {
    return get().widgets[backendId]?.find((w) => w.id === widgetId);
  },
}));
```

`src/stores/dashboardStore.ts`:

```ts
import { create } from "zustand";
import type {
  CardView, Dashboard, DashboardCard, ParamValues, WidgetDef,
} from "../lib/types";
import {
  deleteDashboard, loadDashboards, saveDashboard,
} from "../lib/persistence";

export const GRID_COLS = 60;
export const GRID_ROW_HEIGHT = 24; // px per grid row

interface LayoutItem { i: string; x: number; y: number; w: number; h: number; }

interface DashboardState {
  dashboards: Dashboard[];
  activeId: string | null;
  load(): Promise<void>;
  setActive(id: string): void;
  active(): Dashboard | null;
  addDashboard(name: string): Promise<string>;
  renameDashboard(id: string, name: string): Promise<void>;
  removeDashboard(id: string): Promise<void>;
  addCard(widget: WidgetDef, backendId: string): Promise<void>;
  removeCard(uuid: string): Promise<void>;
  updateLayouts(layouts: LayoutItem[]): Promise<void>;
  setCardParams(uuid: string, params: ParamValues): Promise<void>;
  setCardView(uuid: string, view: CardView): Promise<void>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const useDashboardStore = create<DashboardState>((set, get) => {
  async function mutateActive(fn: (d: Dashboard) => Dashboard): Promise<void> {
    const { dashboards, activeId } = get();
    const idx = dashboards.findIndex((d) => d.id === activeId);
    if (idx < 0) return;
    const next = fn(dashboards[idx]);
    const nextList = [...dashboards];
    nextList[idx] = next;
    set({ dashboards: nextList });
    await saveDashboard(next);
  }

  return {
    dashboards: [],
    activeId: null,
    async load() {
      const dashboards = await loadDashboards();
      set({ dashboards, activeId: dashboards[0]?.id ?? null });
    },
    setActive(id) {
      set({ activeId: id });
    },
    active() {
      const { dashboards, activeId } = get();
      return dashboards.find((d) => d.id === activeId) ?? null;
    },
    async addDashboard(name) {
      const d: Dashboard = { id: crypto.randomUUID(), name, cards: [] };
      set({ dashboards: [...get().dashboards, d], activeId: d.id });
      await saveDashboard(d);
      return d.id;
    },
    async renameDashboard(id, name) {
      const nextList = get().dashboards.map((d) =>
        d.id === id ? { ...d, name } : d
      );
      set({ dashboards: nextList });
      const d = nextList.find((x) => x.id === id);
      if (d) await saveDashboard(d);
    },
    async removeDashboard(id) {
      const rest = get().dashboards.filter((d) => d.id !== id);
      set({
        dashboards: rest,
        activeId: get().activeId === id ? rest[0]?.id ?? null : get().activeId,
      });
      await deleteDashboard(id);
    },
    async addCard(widget, backendId) {
      await mutateActive((d) => {
        const bottom = d.cards.reduce(
          (m, c) => Math.max(m, c.layout.y + c.layout.h), 0
        );
        const card: DashboardCard = {
          uuid: crypto.randomUUID(),
          widgetId: widget.id,
          backendId,
          layout: {
            x: 0,
            y: bottom,
            w: clamp(widget.gridData.w, 4, GRID_COLS),
            h: clamp(widget.gridData.h, 3, 60),
          },
          params: {},
          view: widget.type === "chart" ? "chart" : "default",
        };
        return { ...d, cards: [...d.cards, card] };
      });
    },
    async removeCard(uuid) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.filter((c) => c.uuid !== uuid),
      }));
    },
    async updateLayouts(layouts) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => {
          const l = layouts.find((x) => x.i === c.uuid);
          return l ? { ...c, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : c;
        }),
      }));
    },
    async setCardParams(uuid, params) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => (c.uuid === uuid ? { ...c, params } : c)),
      }));
    },
    async setCardView(uuid, view) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => (c.uuid === uuid ? { ...c, view } : c)),
      }));
    },
  };
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run src/stores`
Expected: PASS (7 tests across both files).

- [ ] **Step 6: Commit**

```bash
cd $REPO_ROOT
git add src/stores/
git commit -m "feat: zustand stores for settings, backends, widget registry, dashboards"
```

---

### Task 6: useHoverPanel hook, app shell, left rail, Rita pane chrome, dark theme

**Files:**
- Create: `$REPO_ROOT/src/hooks/useHoverPanel.ts`
- Test: `$REPO_ROOT/src/hooks/useHoverPanel.test.ts`
- Create: `$REPO_ROOT/src/components/AppShell.tsx`
- Create: `$REPO_ROOT/src/components/LeftRail.tsx`
- Create: `$REPO_ROOT/src/components/RitaPane.tsx`
- Modify: `$REPO_ROOT/src/App.tsx` (replace scaffold content)
- Modify: `$REPO_ROOT/src/main.tsx` (replace scaffold content)
- Create: `$REPO_ROOT/src/styles.css` (delete scaffold's `App.css`/`index.css`... actually: delete `src/App.css`, replace `src/index.css` usage — see Step 5)

**Interfaces:**
- Consumes: all four stores (Task 5).
- Produces (used by Tasks 7, 8, 16, 17):
  - `useHoverPanel({ collapseDelayMs, sticky }: { collapseDelayMs: number; sticky: boolean }): { expanded: boolean; onMouseEnter(): void; onMouseLeave(): void; open(): void; close(): void }`
  - `AppShell` renders the three zones and owns dialog/panel open state. It renders these placeholders replaced by later tasks: `<div id="dashboard-slot" />` (Task 7), library panel slot (Task 8), Rita pane body placeholder (Task 16), dialogs (Task 17).
  - `LeftRail` props: `{ onOpenLibrary(): void; onOpenBackends(): void; onOpenSettings(): void }`
  - `RitaPane` props: `{ pinned: boolean; sticky: boolean; onTogglePin(): void; children: React.ReactNode }`
  - CSS custom properties in `styles.css` used by all later components: `--bg`, `--bg-panel`, `--bg-card`, `--border`, `--text`, `--text-dim`, `--accent`, `--error`
  - Layout constants embodied in CSS: rail 48px collapsed / 240px expanded overlay; Rita strip 24px / 380px expanded; 300ms collapse delay passed to the hook.

- [ ] **Step 1: Write the failing hook test** — `src/hooks/useHoverPanel.test.ts`

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoverPanel } from "./useHoverPanel";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useHoverPanel", () => {
  it("expands immediately on mouse enter", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );
    expect(result.current.expanded).toBe(false);
    act(() => result.current.onMouseEnter());
    expect(result.current.expanded).toBe(true);
  });

  it("collapses only after the delay elapses", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );
    act(() => result.current.onMouseEnter());
    act(() => result.current.onMouseLeave());
    act(() => vi.advanceTimersByTime(299));
    expect(result.current.expanded).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.expanded).toBe(false);
  });

  it("cancels the collapse when the mouse re-enters within the delay", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );
    act(() => result.current.onMouseEnter());
    act(() => result.current.onMouseLeave());
    act(() => vi.advanceTimersByTime(150));
    act(() => result.current.onMouseEnter());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.expanded).toBe(true);
  });

  it("stays open while sticky (focused input / streaming), regardless of mouse", () => {
    const { result, rerender } = renderHook(
      ({ sticky }) => useHoverPanel({ collapseDelayMs: 300, sticky }),
      { initialProps: { sticky: true } }
    );
    act(() => result.current.onMouseEnter());
    act(() => result.current.onMouseLeave());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.expanded).toBe(true);
    // sticky released with mouse outside -> collapses after the delay
    rerender({ sticky: false });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.expanded).toBe(false);
  });

  it("open() and close() are immediate", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );
    act(() => result.current.open());
    expect(result.current.expanded).toBe(true);
    act(() => result.current.close());
    expect(result.current.expanded).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/hooks/useHoverPanel.test.ts`
Expected: FAIL — `Cannot find module './useHoverPanel'`.

- [ ] **Step 3: Implement `src/hooks/useHoverPanel.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";

export interface HoverPanelOptions {
  collapseDelayMs: number;
  /** while true the panel never auto-collapses (input focus, streaming, pinned) */
  sticky: boolean;
}

export interface HoverPanel {
  expanded: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  open: () => void;
  close: () => void;
}

export function useHoverPanel({
  collapseDelayMs, sticky,
}: HoverPanelOptions): HoverPanel {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inside = useRef(false);
  const stickyRef = useRef(sticky);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!inside.current && !stickyRef.current) setExpanded(false);
    }, collapseDelayMs);
  }, [cancel, collapseDelayMs]);

  useEffect(() => {
    stickyRef.current = sticky;
    // sticky released while the mouse is already gone -> start the collapse
    if (!sticky && !inside.current) scheduleCollapse();
  }, [sticky, scheduleCollapse]);

  useEffect(() => cancel, [cancel]);

  const onMouseEnter = useCallback(() => {
    inside.current = true;
    cancel();
    setExpanded(true);
  }, [cancel]);

  const onMouseLeave = useCallback(() => {
    inside.current = false;
    scheduleCollapse();
  }, [scheduleCollapse]);

  const open = useCallback(() => {
    cancel();
    setExpanded(true);
  }, [cancel]);

  const close = useCallback(() => {
    inside.current = false;
    cancel();
    setExpanded(false);
  }, [cancel]);

  return { expanded, onMouseEnter, onMouseLeave, open, close };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/hooks/useHoverPanel.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Replace the scaffold styling with `src/styles.css`**

Delete `src/App.css`. Replace the entire contents of `src/index.css` with a single import shim OR simply delete `src/index.css` and create `src/styles.css` (imported from `main.tsx`). Create `src/styles.css`:

```css
:root {
  --bg: #0e1116;
  --bg-panel: #151a21;
  --bg-card: #1a212b;
  --border: #2a3441;
  --text: #d8dee9;
  --text-dim: #8792a2;
  --accent: #4f8cc9;
  --error: #d9695f;
  color-scheme: dark;
}

* { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
}

button {
  background: var(--bg-card);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}
button:hover { border-color: var(--accent); }

input, select, textarea {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 6px;
}

/* ---- app shell ---- */
.app-shell {
  display: flex;
  height: 100%;
  position: relative;
  overflow: hidden;
}
.main-area {
  flex: 1;
  min-width: 0;
  margin-left: 48px;   /* room for the collapsed rail */
  margin-right: 24px;  /* room for the collapsed Rita strip */
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.app-shell.rita-pinned .main-area { margin-right: 0; }

/* ---- left rail ---- */
.left-rail {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 48px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 40;
  overflow: hidden;
}
.left-rail.expanded { width: 240px; box-shadow: 4px 0 16px rgba(0,0,0,0.5); }
.rail-top { flex: 1; }
.rail-bottom { border-top: 1px solid var(--border); }
.rail-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: none;
  border-radius: 0;
  color: var(--text);
  white-space: nowrap;
  text-align: left;
}
.rail-item:hover { background: var(--bg-card); }
.rail-icon { width: 20px; text-align: center; flex: none; }
.rail-dash-list { padding-left: 44px; }
.rail-dash-list button {
  display: block;
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  color: var(--text-dim);
  padding: 4px 0;
}
.rail-dash-list button.active { color: var(--accent); }

/* ---- Rita pane ---- */
.rita-pane {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 24px;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  z-index: 40;
  display: flex;
  flex-direction: column;
}
.rita-pane.expanded { width: 380px; box-shadow: -4px 0 16px rgba(0,0,0,0.5); }
.rita-pane.pinned {
  position: relative;
  flex: none;
  width: 380px;
  box-shadow: none;
}
.rita-tab {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  margin: auto;
  color: var(--text-dim);
  letter-spacing: 2px;
  user-select: none;
}
.rita-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.rita-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ---- shared bits used by later tasks ---- */
.error-box { color: var(--error); padding: 8px; }
.raw-json {
  overflow: auto;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  white-space: pre;
  margin: 0;
  padding: 8px;
}
```

- [ ] **Step 6: Implement `src/components/LeftRail.tsx`**

```tsx
import { useHoverPanel } from "../hooks/useHoverPanel";
import { useDashboardStore } from "../stores/dashboardStore";

export interface LeftRailProps {
  onOpenLibrary(): void;
  onOpenBackends(): void;
  onOpenSettings(): void;
}

export default function LeftRail({
  onOpenLibrary, onOpenBackends, onOpenSettings,
}: LeftRailProps) {
  const panel = useHoverPanel({ collapseDelayMs: 300, sticky: false });
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);

  return (
    <nav
      className={`left-rail ${panel.expanded ? "expanded" : ""}`}
      onMouseEnter={panel.onMouseEnter}
      onMouseLeave={panel.onMouseLeave}
      aria-label="Navigation rail"
    >
      <div className="rail-top">
        <button className="rail-item" title="Dashboards">
          <span className="rail-icon">▦</span>
          {panel.expanded && <span>Dashboards</span>}
        </button>
        {panel.expanded && (
          <div className="rail-dash-list">
            {dashboards.map((d) => (
              <button
                key={d.id}
                className={d.id === activeId ? "active" : ""}
                onClick={() => setActive(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
        <button className="rail-item" title="Widget Library" onClick={onOpenLibrary}>
          <span className="rail-icon">⊞</span>
          {panel.expanded && <span>Widget Library</span>}
        </button>
      </div>
      <div className="rail-bottom">
        <button className="rail-item" title="Backends" onClick={onOpenBackends}>
          <span className="rail-icon">⛁</span>
          {panel.expanded && <span>Backends</span>}
        </button>
        <button className="rail-item" title="Settings" onClick={onOpenSettings}>
          <span className="rail-icon">⚙</span>
          {panel.expanded && <span>Settings</span>}
        </button>
      </div>
    </nav>
  );
}
```

- [ ] **Step 7: Implement `src/components/RitaPane.tsx`**

```tsx
import type { ReactNode } from "react";
import { useHoverPanel } from "../hooks/useHoverPanel";

export interface RitaPaneProps {
  pinned: boolean;
  /** true while chat input is focused or a response is streaming */
  sticky: boolean;
  onTogglePin(): void;
  children: ReactNode;
}

export default function RitaPane({
  pinned, sticky, onTogglePin, children,
}: RitaPaneProps) {
  const panel = useHoverPanel({ collapseDelayMs: 300, sticky: pinned || sticky });
  const expanded = pinned || panel.expanded;

  return (
    <aside
      className={`rita-pane ${expanded ? "expanded" : ""} ${pinned ? "pinned" : ""}`}
      onMouseEnter={panel.onMouseEnter}
      onMouseLeave={panel.onMouseLeave}
      aria-label="Rita AI pane"
    >
      {expanded ? (
        <div className="rita-body">
          <div className="rita-header">
            <strong>Rita</strong>
            <button onClick={onTogglePin} title="Pin pane (Cmd/Ctrl+Shift+A)">
              {pinned ? "Unpin" : "Pin"}
            </button>
          </div>
          {children}
        </div>
      ) : (
        <div className="rita-tab">Rita</div>
      )}
    </aside>
  );
}
```

- [ ] **Step 8: Implement `src/components/AppShell.tsx`**

```tsx
import { useEffect, useState } from "react";
import LeftRail from "./LeftRail";
import RitaPane from "./RitaPane";

export default function AppShell() {
  const [pinned, setPinned] = useState(false);
  const [chatSticky, setChatSticky] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [backendsOpen, setBackendsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setPinned((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Placeholders below are replaced by later tasks:
  // - dashboard-slot        -> Task 7 (DashboardTabs + DashboardGrid)
  // - library placeholder   -> Task 8 (WidgetLibrary)
  // - Rita pane children    -> Task 16 (ChatPane; wire onActivityChange={setChatSticky})
  // - dialogs               -> Task 17 (BackendsDialog / SettingsDialog)
  void setChatSticky; // used from Task 16 on
  return (
    <div className={`app-shell ${pinned ? "rita-pinned" : ""}`}>
      <LeftRail
        onOpenLibrary={() => setLibraryOpen((v) => !v)}
        onOpenBackends={() => setBackendsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-area">
        <div id="dashboard-slot" style={{ flex: 1, padding: 16 }}>
          Dashboard area (Task 7)
        </div>
      </main>
      {libraryOpen && (
        <div className="library-panel">Widget library (Task 8)</div>
      )}
      {backendsOpen && (
        <div className="modal-placeholder" onClick={() => setBackendsOpen(false)}>
          Backends dialog (Task 17)
        </div>
      )}
      {settingsOpen && (
        <div className="modal-placeholder" onClick={() => setSettingsOpen(false)}>
          Settings dialog (Task 17)
        </div>
      )}
      <RitaPane
        pinned={pinned}
        sticky={chatSticky}
        onTogglePin={() => setPinned((p) => !p)}
      >
        <div style={{ padding: 12, color: "var(--text-dim)" }}>
          Chat pane (Task 16)
        </div>
      </RitaPane>
    </div>
  );
}
```

- [ ] **Step 9: Replace `src/App.tsx` and `src/main.tsx`**

`src/App.tsx`:

```tsx
import { useEffect } from "react";
import AppShell from "./components/AppShell";
import { useBackendsStore } from "./stores/backendsStore";
import { useDashboardStore } from "./stores/dashboardStore";
import { useRegistryStore } from "./stores/registryStore";
import { useSettingsStore } from "./stores/settingsStore";
import { logError } from "./lib/logger";

export default function App() {
  useEffect(() => {
    (async () => {
      try {
        await useSettingsStore.getState().load();
        await useBackendsStore.getState().load();
        await useDashboardStore.getState().load();
        // never block launch on the network: fire and forget
        void useRegistryStore
          .getState()
          .refresh(useBackendsStore.getState().backends);
      } catch (e) {
        logError(`startup load failed: ${String(e)}`);
      }
    })();
  }, []);

  return <AppShell />;
}
```

`src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

Delete `src/App.css` and `src/index.css` (and remove any scaffold imports of them; also delete scaffold's `src/assets/` if only used by the demo page).

- [ ] **Step 10: Verify manually in the running app**

Run: `pnpm tauri dev`
Verify all of:
1. Left rail is 48px of icons; mouse-enter expands it to 240px **overlaying** the center (the "Dashboard area" text must NOT shift); mouse-leave collapses it about 300ms later.
2. Expanded rail lists "Main" under Dashboards.
3. Right edge shows a 24px strip with vertical "Rita"; hover expands a 380px overlay with a Pin button; leaving collapses after ~300ms.
4. Pressing Cmd+Shift+A docks the pane (center content narrows — grid reflows); pressing again returns to overlay mode. The Pin button does the same.
5. No console errors in the devtools (right-click → Inspect).

- [ ] **Step 11: Commit**

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: app shell with hover-expanding left rail and pinnable Rita pane (useHoverPanel)"
```

---
### Task 7: Dashboard grid, tab strip, widget-card chrome

**Files:**
- Create: `$REPO_ROOT/src/components/DashboardTabs.tsx`
- Create: `$REPO_ROOT/src/components/DashboardGrid.tsx`
- Create: `$REPO_ROOT/src/components/WidgetCard.tsx`
- Modify: `$REPO_ROOT/src/components/AppShell.tsx` (replace `#dashboard-slot` placeholder)
- Modify: `$REPO_ROOT/src/styles.css` (append grid/card/tab styles)
- Test: `$REPO_ROOT/src/components/DashboardTabs.test.tsx`

**Interfaces:**
- Consumes: `useDashboardStore` (incl. `GRID_COLS`, `GRID_ROW_HEIGHT`), `useRegistryStore` (Task 5); `DashboardCard` type (Task 2).
- Produces:
  - `DashboardGrid` (no props) — renders the active dashboard's cards in react-grid-layout; drag handle is `.card-title`; layout changes persist via `updateLayouts`.
  - `DashboardTabs` (no props) — tab strip: click switches, double-click renames (window.prompt), ✕ deletes (window.confirm), + adds.
  - `WidgetCard` props: `{ card: DashboardCard }` — chrome (title, remove button) with a placeholder body; **Tasks 9–12 extend this same file** (header param controls, refresh, view toggle, real renderers).

- [ ] **Step 1: Write the failing tab test** — `src/components/DashboardTabs.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DashboardTabs from "./DashboardTabs";
import { useDashboardStore } from "../stores/dashboardStore";

describe("DashboardTabs", () => {
  it("renders tabs and switches the active dashboard on click", () => {
    useDashboardStore.setState({
      dashboards: [
        { id: "d1", name: "Main", cards: [] },
        { id: "d2", name: "Macro", cards: [] },
      ],
      activeId: "d1",
    });
    render(<DashboardTabs />);
    expect(screen.getByText("Main")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Macro"));
    expect(useDashboardStore.getState().activeId).toBe("d2");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/DashboardTabs.test.tsx`
Expected: FAIL — `Cannot find module './DashboardTabs'`.

- [ ] **Step 3: Implement `src/components/DashboardTabs.tsx`**

```tsx
import { useDashboardStore } from "../stores/dashboardStore";

export default function DashboardTabs() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);

  return (
    <div className="dash-tabs">
      {dashboards.map((d) => (
        <div key={d.id} className={`dash-tab ${d.id === activeId ? "active" : ""}`}>
          <button
            className="dash-tab-name"
            onClick={() => setActive(d.id)}
            onDoubleClick={() => {
              const name = window.prompt("Rename dashboard", d.name);
              if (name) void renameDashboard(d.id, name);
            }}
          >
            {d.name}
          </button>
          {dashboards.length > 1 && (
            <button
              className="dash-tab-close"
              title="Delete dashboard"
              onClick={() => {
                if (window.confirm(`Delete dashboard "${d.name}"?`)) {
                  void removeDashboard(d.id);
                }
              }}
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        className="dash-tab-add"
        title="New dashboard"
        onClick={() => {
          const name = window.prompt("New dashboard name", "Untitled");
          if (name) void addDashboard(name);
        }}
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/components/DashboardTabs.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 5: Implement `src/components/WidgetCard.tsx`** (chrome only in this task)

```tsx
import type { DashboardCard } from "../lib/types";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";

export interface WidgetCardProps {
  card: DashboardCard;
}

export default function WidgetCard({ card }: WidgetCardProps) {
  const removeCard = useDashboardStore((s) => s.removeCard);
  const widget = useRegistryStore((s) => s.find(card.backendId, card.widgetId));

  return (
    <div className="widget-card">
      <div className="card-header">
        <span className="card-title">{widget?.name ?? card.widgetId}</span>
        <span className="card-actions">
          <button title="Remove widget" onClick={() => void removeCard(card.uuid)}>
            ✕
          </button>
        </span>
      </div>
      <div className="card-body">
        {widget ? (
          <div className="raw-json">Renderer arrives in Tasks 9–12</div>
        ) : (
          <div className="error-box">
            Widget "{card.widgetId}" is not available from backend "
            {card.backendId}" (backend offline or widget removed). Saved layout
            kept.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Implement `src/components/DashboardGrid.tsx`**

```tsx
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  GRID_COLS, GRID_ROW_HEIGHT, useDashboardStore,
} from "../stores/dashboardStore";
import WidgetCard from "./WidgetCard";

const Grid = WidthProvider(GridLayout);

export default function DashboardGrid() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const updateLayouts = useDashboardStore((s) => s.updateLayouts);
  const dashboard = dashboards.find((d) => d.id === activeId);

  if (!dashboard) {
    return <div className="error-box">No dashboard selected.</div>;
  }

  const layout: Layout[] = dashboard.cards.map((c) => ({
    i: c.uuid, x: c.layout.x, y: c.layout.y, w: c.layout.w, h: c.layout.h,
  }));

  return (
    <div className="dashboard-grid">
      <Grid
        layout={layout}
        cols={GRID_COLS}
        rowHeight={GRID_ROW_HEIGHT}
        margin={[8, 8]}
        draggableHandle=".card-title"
        onLayoutChange={(l) =>
          void updateLayouts(
            l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
          )
        }
      >
        {dashboard.cards.map((c) => (
          <div key={c.uuid}>
            <WidgetCard card={c} />
          </div>
        ))}
      </Grid>
      {dashboard.cards.length === 0 && (
        <div className="empty-dash">
          Empty dashboard — add widgets from the library (left rail ⊞).
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Wire into `AppShell.tsx`**

In `src/components/AppShell.tsx` add the imports and replace the `#dashboard-slot` placeholder `<div>` inside `<main className="main-area">`:

```tsx
import DashboardGrid from "./DashboardGrid";
import DashboardTabs from "./DashboardTabs";
```

```tsx
      <main className="main-area">
        <DashboardTabs />
        <DashboardGrid />
      </main>
```

- [ ] **Step 8: Append styles to `src/styles.css`**

```css
/* ---- dashboard tabs + grid ---- */
.dash-tabs {
  display: flex; align-items: center; gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex: none;
}
.dash-tab { display: flex; align-items: center; border: 1px solid var(--border); border-radius: 4px; }
.dash-tab.active { border-color: var(--accent); }
.dash-tab-name { border: none; background: none; }
.dash-tab-close { border: none; background: none; color: var(--text-dim); padding: 2px 6px; }
.dash-tab-add { margin-left: 4px; }

.dashboard-grid { flex: 1; overflow: auto; position: relative; }
.empty-dash {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); pointer-events: none;
}

/* ---- widget card ---- */
.widget-card {
  height: 100%;
  display: flex; flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.card-header {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
  flex: none;
}
.card-title {
  cursor: grab; font-weight: 600; flex: 1; min-width: 60px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-actions { display: flex; gap: 4px; }
.card-body { flex: 1; min-height: 0; overflow: auto; position: relative; }
```

- [ ] **Step 9: Verify manually**

Run: `pnpm tauri dev`
Verify:
1. Tab strip shows "Main"; + creates a second dashboard (prompt), double-click renames, ✕ (with confirm) deletes.
2. The grid area shows the "Empty dashboard" hint (no cards exist yet — adding comes in Task 8).
3. Quit and relaunch: dashboards (names) persist. On macOS confirm files exist: `ls "$HOME/Library/Application Support/com.<owner>.openbb-desk/dashboards/"`.

- [ ] **Step 10: Commit**

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: dashboard tab strip and react-grid-layout grid with persisted card chrome"
```

---

### Task 8: Widget library panel

**Files:**
- Create: `$REPO_ROOT/src/components/WidgetLibrary.tsx`
- Modify: `$REPO_ROOT/src/components/AppShell.tsx` (replace library placeholder)
- Modify: `$REPO_ROOT/src/styles.css` (append library styles)
- Test: `$REPO_ROOT/src/components/WidgetLibrary.test.tsx`

**Interfaces:**
- Consumes: `useRegistryStore`, `useBackendsStore`, `useDashboardStore` (Task 5); `WidgetDef` (Task 2).
- Produces: `WidgetLibrary` props `{ onClose(): void }` — searchable, category-grouped list of discovered widgets; clicking an item calls `useDashboardStore.addCard(widget, backendId)`.

- [ ] **Step 1: Write the failing test** — `src/components/WidgetLibrary.test.tsx`

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetDef } from "../lib/types";

vi.mock("../lib/persistence", () => ({
  loadDashboards: vi.fn(async () => []),
  saveDashboard: vi.fn(async () => {}),
  deleteDashboard: vi.fn(async () => {}),
}));

import WidgetLibrary from "./WidgetLibrary";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import { useBackendsStore } from "../stores/backendsStore";

const mkWidget = (id: string, name: string, category: string): WidgetDef => ({
  id, name, description: `${name} desc`, category, subCategory: null,
  type: "table", endpoint: `/api/${id}`, gridData: { w: 20, h: 10 },
  source: [], runButton: false, raw: false, refetchInterval: null,
  params: [], dataKey: null, columnsDefs: null, mcpUrl: null,
});

beforeEach(() => {
  useBackendsStore.setState({
    backends: [{ id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net" }],
    status: {},
  });
  useRegistryStore.setState({
    loading: false,
    widgets: {
      nas: [
        mkWidget("w_hist", "Historical", "Equity"),
        mkWidget("w_gdp", "GDP", "Economy"),
      ],
    },
  });
  useDashboardStore.setState({
    dashboards: [{ id: "d1", name: "Main", cards: [] }],
    activeId: "d1",
  });
});

describe("WidgetLibrary", () => {
  it("groups by category and filters by search", () => {
    render(<WidgetLibrary onClose={() => {}} />);
    expect(screen.getByText("Equity", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Economy", { exact: false })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search widgets…"), {
      target: { value: "gdp" },
    });
    expect(screen.queryByText("Historical")).not.toBeInTheDocument();
    expect(screen.getByText("GDP")).toBeInTheDocument();
  });

  it("adds a card to the active dashboard on click", async () => {
    render(<WidgetLibrary onClose={() => {}} />);
    fireEvent.click(screen.getByText("Historical"));
    await vi.waitFor(() => {
      const cards = useDashboardStore.getState().dashboards[0].cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].widgetId).toBe("w_hist");
      expect(cards[0].backendId).toBe("nas");
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: FAIL — `Cannot find module './WidgetLibrary'`.

- [ ] **Step 3: Implement `src/components/WidgetLibrary.tsx`**

```tsx
import { useMemo, useState } from "react";
import type { WidgetDef } from "../lib/types";
import { useBackendsStore } from "../stores/backendsStore";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";

export interface WidgetLibraryProps {
  onClose(): void;
}

interface Entry { backendId: string; widget: WidgetDef; }

export default function WidgetLibrary({ onClose }: WidgetLibraryProps) {
  const [query, setQuery] = useState("");
  const widgetsByBackend = useRegistryStore((s) => s.widgets);
  const loading = useRegistryStore((s) => s.loading);
  const refresh = useRegistryStore((s) => s.refresh);
  const backends = useBackendsStore((s) => s.backends);
  const addCard = useDashboardStore((s) => s.addCard);

  const byCategory = useMemo(() => {
    const q = query.trim().toLowerCase();
    const entries: Entry[] = [];
    for (const [backendId, widgets] of Object.entries(widgetsByBackend)) {
      for (const widget of widgets) {
        const hay = `${widget.name} ${widget.description} ${widget.category} ${
          widget.subCategory ?? ""
        }`.toLowerCase();
        if (q === "" || hay.includes(q)) entries.push({ backendId, widget });
      }
    }
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      const list = m.get(e.widget.category) ?? [];
      list.push(e);
      m.set(e.widget.category, list);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [widgetsByBackend, query]);

  return (
    <div className="library-panel">
      <div className="library-header">
        <input
          autoFocus
          placeholder="Search widgets…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => void refresh(backends)} disabled={loading}>
          {loading ? "…" : "Refresh"}
        </button>
        <button onClick={onClose} title="Close library">✕</button>
      </div>
      <div className="library-list">
        {byCategory.length === 0 && (
          <div className="error-box">
            {loading
              ? "Loading widgets…"
              : "No widgets discovered. Check the Backends dialog."}
          </div>
        )}
        {byCategory.map(([category, list]) => (
          <section key={category}>
            <h3>
              {category} <span className="lib-count">({list.length})</span>
            </h3>
            {list.map(({ backendId, widget }) => (
              <button
                key={`${backendId}:${widget.id}`}
                className="lib-item"
                title={widget.description}
                onClick={() => void addCard(widget, backendId)}
              >
                <span className="lib-name">{widget.name}</span>
                <span className="lib-meta">
                  {widget.type}
                  {widget.subCategory ? ` · ${widget.subCategory}` : ""}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into `AppShell.tsx` and add styles**

In `src/components/AppShell.tsx`, add `import WidgetLibrary from "./WidgetLibrary";` and replace the library placeholder:

```tsx
      {libraryOpen && <WidgetLibrary onClose={() => setLibraryOpen(false)} />}
```

Append to `src/styles.css`:

```css
/* ---- widget library ---- */
.library-panel {
  position: absolute;
  left: 48px; top: 0; bottom: 0;
  width: 340px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  z-index: 35;
  display: flex; flex-direction: column;
  box-shadow: 4px 0 16px rgba(0, 0, 0, 0.5);
}
.library-header {
  display: flex; gap: 6px; padding: 8px;
  border-bottom: 1px solid var(--border);
}
.library-header input { flex: 1; }
.library-list { flex: 1; overflow: auto; padding: 4px 8px; }
.library-list h3 { margin: 10px 0 4px; font-size: 12px; color: var(--text-dim); }
.lib-count { font-weight: normal; }
.lib-item {
  display: flex; flex-direction: column; align-items: flex-start;
  width: 100%; margin-bottom: 4px; text-align: left;
}
.lib-name { font-weight: 600; }
.lib-meta { color: var(--text-dim); font-size: 11px; }
```

- [ ] **Step 6: Verify manually against the live NAS**

Run: `pnpm tauri dev`
Verify:
1. Click the ⊞ rail icon: the library panel opens over the grid, listing real NAS widgets grouped by category (442 entries — search "historical" narrows the list).
2. Click "Historical" (Equity · Price): a card appears on the grid sized ~40x15 grid units; drag it by its title, resize from the corner, remove via ✕.
3. Restart the app: the card and its position persist (body still shows the Task 9–12 placeholder — fine).

- [ ] **Step 7: Commit**

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: searchable category-grouped widget library that adds cards to the active dashboard"
```

---
### Task 9: Parameter engine ($currentDate resolver) and param controls in the card header

**Files:**
- Create: `$REPO_ROOT/src/lib/params.ts`
- Test: `$REPO_ROOT/src/lib/params.test.ts`
- Create: `$REPO_ROOT/src/components/ParamControls.tsx`
- Modify: `$REPO_ROOT/src/components/WidgetCard.tsx` (add param controls + refresh to the header)
- Modify: `$REPO_ROOT/src/styles.css` (append param styles)

**Interfaces:**
- Consumes: types (Task 2); `fetchJson`, `serializeParams` (Task 3); `logOnce` (Task 4); `useDashboardStore.setCardParams` (Task 5).
- Produces (used by Tasks 10, 12, 14):
  - `resolveDefaultValue(value: string, now: Date): string` — `"$currentDate"`, `"$currentDate-1w"`, `"$currentDate+1d"` etc. (units `h d w M y`) → local `YYYY-MM-DD`; non-matching strings returned unchanged.
  - `initialParamValues(widget: WidgetDef, now?: Date): ParamValues` — default value per param (hidden params included), `$currentDate` strings resolved.
  - `resolveOptionsParams(optionsParams: Record<string, string> | null, values: ParamValues): ParamValues` — `"$name"` references replaced by current values.
  - `normalizeOptions(json: unknown): ParamOption[]` — accepts `[{label,value}]` or `["a","b"]`.
  - `ParamControls` props: `{ widget: WidgetDef; backend: BackendConfig; values: ParamValues; onChange(name: string, value: string | number | boolean | string[] | null): void }`.
  - `WidgetCard` now keeps `refreshKey: number` state (Refresh button increments it) and computes `values = { ...initialParamValues(widget), ...card.params }` — Task 10's `WidgetBody` consumes both.

- [ ] **Step 1: Write the failing test** — `src/lib/params.test.ts`

```ts
import { describe, expect, it } from "vitest";
import fixtures from "../test/fixtures/widgets.fixture.json";
import { parseWidgetsJson } from "./widgets";
import {
  initialParamValues, normalizeOptions, resolveDefaultValue,
  resolveOptionsParams,
} from "./params";

const now = new Date(2026, 6, 30, 12, 0, 0); // 2026-07-30 local noon

describe("resolveDefaultValue", () => {
  it("resolves $currentDate and modifiers to YYYY-MM-DD", () => {
    expect(resolveDefaultValue("$currentDate", now)).toBe("2026-07-30");
    expect(resolveDefaultValue("$currentDate-1w", now)).toBe("2026-07-23");
    expect(resolveDefaultValue("$currentDate+1d", now)).toBe("2026-07-31");
    expect(resolveDefaultValue("$currentDate-3M", now)).toBe("2026-04-30");
    expect(resolveDefaultValue("$currentDate-1y", now)).toBe("2025-07-30");
    expect(resolveDefaultValue("$currentDate-13h", now)).toBe("2026-07-29");
  });
  it("returns non-matching values unchanged", () => {
    expect(resolveDefaultValue("AAPL", now)).toBe("AAPL");
    expect(resolveDefaultValue("2026-01-01", now)).toBe("2026-01-01");
  });
});

describe("initialParamValues", () => {
  const widgets = parseWidgetsJson(fixtures);
  const table = widgets.find((w) => w.id === "equity_price_historical_eodhd_obb")!;

  it("collects defaults including hidden params", () => {
    expect(initialParamValues(table, now)).toEqual({
      symbol: null, interval: "1d", exchange: "US", provider: "eodhd",
    });
  });

  it("resolves $currentDate defaults", () => {
    const w = {
      ...table,
      params: [{
        paramName: "start_date", type: "date" as const,
        value: "$currentDate-1w", label: "Start", description: "",
        show: true, multiSelect: false, options: null,
        optionsEndpoint: null, optionsParams: null,
      }],
    };
    expect(initialParamValues(w, now)).toEqual({ start_date: "2026-07-23" });
  });
});

describe("resolveOptionsParams", () => {
  it("substitutes $refs from current values and keeps literals", () => {
    expect(
      resolveOptionsParams(
        { dataflow_group: "$dataflow_group", fixed: "yes" },
        { dataflow_group: "BOP", table: null }
      )
    ).toEqual({ dataflow_group: "BOP", fixed: "yes" });
  });
  it("maps missing refs to null and null input to empty", () => {
    expect(resolveOptionsParams({ a: "$missing" }, {})).toEqual({ a: null });
    expect(resolveOptionsParams(null, {})).toEqual({});
  });
});

describe("normalizeOptions", () => {
  it("accepts {label,value} arrays and scalar arrays", () => {
    expect(normalizeOptions([{ label: "One", value: 1 }])).toEqual([
      { label: "One", value: 1 },
    ]);
    expect(normalizeOptions(["a", "b"])).toEqual([
      { label: "a", value: "a" }, { label: "b", value: "b" },
    ]);
    expect(normalizeOptions({ nope: true })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/params.test.ts`
Expected: FAIL — `Cannot find module './params'`.

- [ ] **Step 3: Implement `src/lib/params.ts`**

```ts
import type { ParamOption, ParamValues, WidgetDef } from "./types";

export function resolveDefaultValue(value: string, now: Date): string {
  const m = /^\$currentDate(?:([+-]\d+)([hdwMy]))?$/.exec(value.trim());
  if (!m) return value;
  const d = new Date(now.getTime());
  if (m[1]) {
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case "h": d.setTime(d.getTime() + n * 3_600_000); break;
      case "d": d.setDate(d.getDate() + n); break;
      case "w": d.setDate(d.getDate() + n * 7); break;
      case "M": d.setMonth(d.getMonth() + n); break;
      case "y": d.setFullYear(d.getFullYear() + n); break;
    }
  }
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function initialParamValues(
  widget: WidgetDef,
  now: Date = new Date()
): ParamValues {
  const out: ParamValues = {};
  for (const p of widget.params) {
    let v = p.value;
    if (typeof v === "string" && v.startsWith("$currentDate")) {
      v = resolveDefaultValue(v, now);
    }
    out[p.paramName] = v;
  }
  return out;
}

export function resolveOptionsParams(
  optionsParams: Record<string, string> | null,
  values: ParamValues
): ParamValues {
  if (!optionsParams) return {};
  const out: ParamValues = {};
  for (const [k, v] of Object.entries(optionsParams)) {
    out[k] = v.startsWith("$") ? values[v.slice(1)] ?? null : v;
  }
  return out;
}

export function normalizeOptions(json: unknown): ParamOption[] {
  if (!Array.isArray(json)) return [];
  const out: ParamOption[] = [];
  for (const item of json) {
    if (typeof item === "string" || typeof item === "number") {
      out.push({ label: String(item), value: item });
    } else if (item !== null && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (rec.value !== undefined || rec.label !== undefined) {
        out.push({
          label: String(rec.label ?? rec.value ?? ""),
          value: (rec.value ?? String(rec.label ?? "")) as ParamOption["value"],
        });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/params.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Implement `src/components/ParamControls.tsx`**

```tsx
import { useEffect, useState } from "react";
import type {
  BackendConfig, ParamDef, ParamOption, ParamValues, WidgetDef,
} from "../lib/types";
import { fetchJson, serializeParams } from "../lib/dataClient";
import { logError, logOnce } from "../lib/logger";
import { normalizeOptions, resolveOptionsParams } from "../lib/params";

export interface ParamControlsProps {
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  onChange(name: string, value: string | number | boolean | string[] | null): void;
}

type OnChange = ParamControlsProps["onChange"];

function SelectControl({
  p, value, options, onChange,
}: {
  p: ParamDef;
  value: ParamValues[string];
  options: ParamOption[];
  onChange: OnChange;
}) {
  if (p.multiSelect) {
    const selected = Array.isArray(value)
      ? value
      : value != null && value !== "" ? [String(value)] : [];
    return (
      <select
        multiple
        value={selected}
        title={p.description}
        onChange={(e) =>
          onChange(
            p.paramName,
            [...e.target.selectedOptions].map((o) => o.value)
          )
        }
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    );
  }
  return (
    <select
      value={value == null ? "" : String(value)}
      title={p.description}
      onChange={(e) => onChange(p.paramName, e.target.value)}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
      ))}
    </select>
  );
}

function EndpointSelect({
  p, widget, backend, values, onChange,
}: {
  p: ParamDef;
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  onChange: OnChange;
}) {
  const [options, setOptions] = useState<ParamOption[]>([]);
  useEffect(() => {
    // fetch once on mount with the current optionsParams values (v1 behavior)
    let cancelled = false;
    (async () => {
      try {
        const url = new URL(p.optionsEndpoint!, backend.baseUrl);
        const q = serializeParams(resolveOptionsParams(p.optionsParams, values));
        for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
        const json = await fetchJson(url.toString(), backend);
        if (!cancelled) setOptions(normalizeOptions(json));
      } catch (e) {
        logError(
          `optionsEndpoint failed for ${widget.id}.${p.paramName}: ${String(e)}`
        );
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <SelectControl p={p} value={values[p.paramName]} options={options} onChange={onChange} />;
}

function Control({
  p, widget, backend, values, onChange,
}: {
  p: ParamDef;
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  onChange: OnChange;
}) {
  const value = values[p.paramName];
  switch (p.type) {
    case "date":
      return (
        <input
          type="date"
          title={p.description}
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(p.paramName, e.target.value || null)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          title={p.description}
          value={value == null ? "" : Number(value)}
          onChange={(e) =>
            onChange(
              p.paramName,
              e.target.value === "" ? null : Number(e.target.value)
            )
          }
          style={{ width: 70 }}
        />
      );
    case "boolean":
      return (
        <input
          type="checkbox"
          title={p.description}
          checked={value === true || value === "true"}
          onChange={(e) => onChange(p.paramName, e.target.checked)}
        />
      );
    case "endpoint":
      return (
        <EndpointSelect
          p={p} widget={widget} backend={backend}
          values={values} onChange={onChange}
        />
      );
    case "form":
    case "tabs":
      logOnce(
        `param-type-${p.type}`,
        `Unsupported param type "${p.type}" (widget ${widget.id}, param ${p.paramName}) — control hidden`
      );
      return null;
    case "ticker":
    case "text":
    default:
      if (p.options && p.options.length > 0) {
        return (
          <SelectControl p={p} value={value} options={p.options} onChange={onChange} />
        );
      }
      return (
        <input
          type="text"
          title={p.description}
          placeholder={p.label}
          value={
            Array.isArray(value) ? value.join(",") : value == null ? "" : String(value)
          }
          onChange={(e) => onChange(p.paramName, e.target.value || null)}
          style={{ width: 90 }}
        />
      );
  }
}

export default function ParamControls({
  widget, backend, values, onChange,
}: ParamControlsProps) {
  const visible = widget.params.filter((p) => p.show);
  if (visible.length === 0) return null;
  return (
    <span className="param-controls">
      {visible.map((p) => (
        <label key={p.paramName} className="param-control" title={p.description}>
          <span className="param-label">{p.label}</span>
          <Control
            p={p} widget={widget} backend={backend}
            values={values} onChange={onChange}
          />
        </label>
      ))}
    </span>
  );
}
```

- [ ] **Step 6: Wire params + refresh into `src/components/WidgetCard.tsx`** (replace the whole file)

```tsx
import { useMemo, useState } from "react";
import type { DashboardCard } from "../lib/types";
import { initialParamValues } from "../lib/params";
import { useBackendsStore } from "../stores/backendsStore";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import ParamControls from "./ParamControls";

export interface WidgetCardProps {
  card: DashboardCard;
}

export default function WidgetCard({ card }: WidgetCardProps) {
  const removeCard = useDashboardStore((s) => s.removeCard);
  const setCardParams = useDashboardStore((s) => s.setCardParams);
  const widget = useRegistryStore((s) => s.find(card.backendId, card.widgetId));
  const backend = useBackendsStore((s) =>
    s.backends.find((b) => b.id === card.backendId)
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const values = useMemo(
    () => (widget ? { ...initialParamValues(widget), ...card.params } : {}),
    [widget, card.params]
  );

  if (!widget || !backend) {
    return (
      <div className="widget-card">
        <div className="card-header">
          <span className="card-title">{card.widgetId}</span>
          <span className="card-actions">
            <button title="Remove widget" onClick={() => void removeCard(card.uuid)}>✕</button>
          </span>
        </div>
        <div className="card-body">
          <div className="error-box">
            Widget "{card.widgetId}" is not available from backend "
            {card.backendId}" (backend offline or widget removed). Saved layout
            kept.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="widget-card">
      <div className="card-header">
        <span className="card-title">{widget.name}</span>
        <ParamControls
          widget={widget}
          backend={backend}
          values={values}
          onChange={(name, value) =>
            void setCardParams(card.uuid, { ...values, [name]: value })
          }
        />
        <span className="card-actions">
          <button title="Refresh" onClick={() => setRefreshKey((k) => k + 1)}>⟳</button>
          <button title="Remove widget" onClick={() => void removeCard(card.uuid)}>✕</button>
        </span>
      </div>
      <div className="card-body">
        {/* WidgetBody (Task 10) replaces this; refreshKey + values are already wired */}
        <pre className="raw-json">{JSON.stringify({ values, refreshKey }, null, 2)}</pre>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Append styles to `src/styles.css`**

```css
/* ---- param controls ---- */
.param-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.param-control { display: flex; gap: 4px; align-items: center; }
.param-label { color: var(--text-dim); font-size: 11px; }
.param-control select[multiple] { max-height: 44px; }
```

- [ ] **Step 8: Verify manually**

Run: `pnpm tauri dev`
With the "Historical" card from Task 8 on the grid, verify:
1. Header shows Symbol (text), Interval (dropdown with 1m/5m/1h/1d/1W/1M, preset "1d"), Exchange (text, preset "US"). No "provider" control (hidden param).
2. Typing "AAPL" into Symbol updates the card body JSON (`values.symbol: "AAPL"`); restart the app — the value persists.
3. ⟳ increments `refreshKey` in the body JSON.
4. Add the "IMF Presentation Table" widget (search "IMF Presentation" in the library): its Dataflow dropdown populates from the live optionsEndpoint after a moment.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: param engine with \$currentDate resolution and generated header controls"
```

---

### Task 10: Data-fetch hook, TanStack table renderer, raw-JSON fallback

**Files:**
- Create: `$REPO_ROOT/src/hooks/useWidgetData.ts`
- Test: `$REPO_ROOT/src/hooks/useWidgetData.test.ts`
- Create: `$REPO_ROOT/src/components/renderers/TableRenderer.tsx`
- Test: `$REPO_ROOT/src/components/renderers/TableRenderer.test.tsx`
- Create: `$REPO_ROOT/src/components/renderers/RawJsonView.tsx`
- Create: `$REPO_ROOT/src/components/WidgetBody.tsx`
- Modify: `$REPO_ROOT/src/components/WidgetCard.tsx` (body → `<WidgetBody …>`)
- Modify: `$REPO_ROOT/src/styles.css` (append table styles)

**Interfaces:**
- Consumes: `fetchWidgetData`, `fetchWidgetHtml`, `HttpError` (Task 3); `logError` (Task 4); types (Task 2); `values`/`refreshKey` wiring in WidgetCard (Task 9).
- Produces:
  - `useWidgetData(backend: BackendConfig | undefined, widget: WidgetDef, values: ParamValues, opts: { raw?: boolean }, refreshKey: number): { status: "loading" | "ready" | "error"; data: unknown; error: string | null }` — html widgets fetch text (data is the HTML string); iframe widgets never fetch (`status: "ready"`, `data: null`); chart widgets fetch with `theme: "dark"`.
  - `TableRenderer` props: `{ records: Record<string, unknown>[]; columnsDefs: ColumnDef[] | null }`; also exports `formatCell(value: unknown, col: ColumnDef): string` and `orderColumns(cols: ColumnDef[]): ColumnDef[]`.
  - `RawJsonView` props: `{ data: unknown }` — pretty-printed `<pre class="raw-json">`.
  - `WidgetBody` props: `{ widget: WidgetDef; backend: BackendConfig; values: ParamValues; view: CardView; refreshKey: number; onRetry(): void }` — Tasks 11–12 extend this file's branch table.

- [ ] **Step 1: Write the failing hook test** — `src/hooks/useWidgetData.test.ts`

```ts
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, WidgetDef } from "../lib/types";

const fetchWidgetData = vi.fn();
const fetchWidgetHtml = vi.fn();
vi.mock("../lib/dataClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/dataClient")>()),
  fetchWidgetData: (...a: unknown[]) => fetchWidgetData(...a),
  fetchWidgetHtml: (...a: unknown[]) => fetchWidgetHtml(...a),
}));
vi.mock("../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

import { useWidgetData } from "./useWidgetData";

const backend: BackendConfig = { id: "nas", name: "NAS", baseUrl: "http://x" };
const mkWidget = (type: string): WidgetDef => ({
  id: "w1", name: "W", description: "", category: "C", subCategory: null,
  type, endpoint: "/api/x", gridData: { w: 20, h: 10 }, source: [],
  runButton: false, raw: false, refetchInterval: null, params: [],
  dataKey: null, columnsDefs: null, mcpUrl: null,
});

beforeEach(() => vi.clearAllMocks());

describe("useWidgetData", () => {
  it("loads json data for table widgets", async () => {
    fetchWidgetData.mockResolvedValueOnce([{ a: 1 }]);
    const { result } = renderHook(() =>
      useWidgetData(backend, mkWidget("table"), { symbol: "AAPL" }, {}, 0)
    );
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toEqual([{ a: 1 }]);
  });

  it("fetches html text for html widgets", async () => {
    fetchWidgetHtml.mockResolvedValueOnce("<b>hi</b>");
    const { result } = renderHook(() =>
      useWidgetData(backend, mkWidget("html"), {}, {}, 0)
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.data).toBe("<b>hi</b>");
    expect(fetchWidgetData).not.toHaveBeenCalled();
  });

  it("never fetches for iframe widgets", async () => {
    const { result } = renderHook(() =>
      useWidgetData(backend, mkWidget("iframe"), {}, {}, 0)
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchWidgetData).not.toHaveBeenCalled();
    expect(fetchWidgetHtml).not.toHaveBeenCalled();
  });

  it("reports errors and refetches when refreshKey changes", async () => {
    fetchWidgetData.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    fetchWidgetData.mockResolvedValueOnce([{ ok: true }]);
    const { result, rerender } = renderHook(
      ({ k }) => useWidgetData(backend, mkWidget("table"), {}, {}, k),
      { initialProps: { k: 0 } }
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toContain("ECONNREFUSED");
    rerender({ k: 1 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/hooks/useWidgetData.test.ts`
Expected: FAIL — `Cannot find module './useWidgetData'`.

- [ ] **Step 3: Implement `src/hooks/useWidgetData.ts`**

```ts
import { useEffect, useState } from "react";
import type { BackendConfig, ParamValues, WidgetDef } from "../lib/types";
import { fetchWidgetData, fetchWidgetHtml } from "../lib/dataClient";
import { logError } from "../lib/logger";

export interface WidgetDataState {
  status: "loading" | "ready" | "error";
  data: unknown;
  error: string | null;
}

export function useWidgetData(
  backend: BackendConfig | undefined,
  widget: WidgetDef,
  values: ParamValues,
  opts: { raw?: boolean },
  refreshKey: number
): WidgetDataState {
  const [state, setState] = useState<WidgetDataState>({
    status: "loading", data: null, error: null,
  });
  const valuesKey = JSON.stringify(values);
  const raw = opts.raw === true;

  useEffect(() => {
    if (widget.type === "iframe") {
      setState({ status: "ready", data: null, error: null });
      return;
    }
    if (!backend) {
      setState({ status: "error", data: null, error: "Backend not configured" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", data: null, error: null });
    (async () => {
      try {
        const data =
          widget.type === "html" && !raw
            ? await fetchWidgetHtml(backend, widget, values)
            : await fetchWidgetData(backend, widget, values, {
                raw,
                theme: widget.type === "chart" ? "dark" : undefined,
              });
        if (!cancelled) setState({ status: "ready", data, error: null });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError(`widget ${widget.id} fetch failed: ${msg}`);
        if (!cancelled) setState({ status: "error", data: null, error: msg });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend?.id, widget.id, widget.type, valuesKey, raw, refreshKey]);

  return state;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/hooks/useWidgetData.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing table test** — `src/components/renderers/TableRenderer.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "../../lib/types";
import historical from "../../test/fixtures/historical.fixture.json";
import TableRenderer, { formatCell, orderColumns } from "./TableRenderer";

describe("formatCell", () => {
  it("formats dates to YYYY-MM-DD", () => {
    expect(formatCell("2026-07-01", { field: "d", cellDataType: "date" })).toBe("2026-07-01");
  });
  it("formats numbers with locale separators and decimalPlaces", () => {
    expect(formatCell(50164200, { field: "v", cellDataType: "number" })).toBe("50,164,200");
    expect(formatCell(294.381, { field: "c", cellDataType: "number", decimalPlaces: 2 })).toBe("294.38");
  });
  it("applies formatterFn int and percent, prefix and suffix", () => {
    expect(formatCell(1234.6, { field: "x", formatterFn: "int" })).toBe("1,235");
    expect(formatCell(0.1234, { field: "x", formatterFn: "percent" })).toBe("12.34%");
    expect(formatCell(5, { field: "x", cellDataType: "number", prefix: "$", suffix: "M" })).toBe("$5M");
  });
  it("renders null/undefined as empty and objects as JSON", () => {
    expect(formatCell(null, { field: "x" })).toBe("");
    expect(formatCell({ a: 1 }, { field: "x", cellDataType: "object" })).toBe('{"a":1}');
  });
});

describe("orderColumns", () => {
  it("drops hidden columns and orders pinned left/right", () => {
    const cols: ColumnDef[] = [
      { field: "mid" },
      { field: "right", pinned: "right" },
      { field: "gone", hide: true },
      { field: "left", pinned: "left" },
    ];
    expect(orderColumns(cols).map((c) => c.field)).toEqual(["left", "mid", "right"]);
  });
});

describe("TableRenderer", () => {
  const columnsDefs: ColumnDef[] = [
    { field: "date", headerName: "Date", headerTooltip: "The date of the data.", cellDataType: "date", pinned: "left" },
    { field: "close", headerName: "Close", cellDataType: "number" },
    { field: "volume", headerName: "Volume", cellDataType: "number" },
  ];

  it("renders headers from columnsDefs and formatted cells", () => {
    render(<TableRenderer records={historical.results} columnsDefs={columnsDefs} />);
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByTitle("The date of the data.")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getByText("50,164,200")).toBeInTheDocument();
  });

  it("infers columns from record keys when columnsDefs is null", () => {
    render(<TableRenderer records={[{ foo: 1, bar: "x" }]} columnsDefs={null} />);
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm vitest run src/components/renderers/TableRenderer.test.tsx`
Expected: FAIL — `Cannot find module './TableRenderer'`.

- [ ] **Step 7: Implement `src/components/renderers/TableRenderer.tsx`**

```tsx
import { useMemo, useState } from "react";
import {
  createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel,
  useReactTable, type SortingState,
} from "@tanstack/react-table";
import type { ColumnDef } from "../../lib/types";

export function formatCell(value: unknown, col: ColumnDef): string {
  if (value === null || value === undefined) return "";
  const fn = col.formatterFn ?? null;
  let out: string;
  if (fn === "int" && typeof value === "number") {
    out = Math.round(value).toLocaleString();
  } else if (fn === "percent" && typeof value === "number") {
    out = `${(value * 100).toFixed(col.decimalPlaces ?? 2)}%`;
  } else if (fn === "none") {
    out = String(value);
  } else if (col.cellDataType === "date" || col.cellDataType === "dateString") {
    const d = new Date(String(value));
    out = Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
  } else if (col.cellDataType === "number" || typeof value === "number") {
    const n = Number(value);
    out = Number.isFinite(n)
      ? n.toLocaleString(undefined, {
          minimumFractionDigits:
            col.decimalPlaces ?? (Number.isInteger(n) ? 0 : 2),
          maximumFractionDigits: col.decimalPlaces ?? (Number.isInteger(n) ? 0 : 2),
        })
      : String(value);
  } else if (typeof value === "object") {
    out = JSON.stringify(value);
  } else {
    out = String(value);
  }
  // other formatterFns (normalized, normalizedPercent, dateToYear) are
  // intentionally ignored in v1 and fall through to the branches above
  return `${col.prefix ?? ""}${out}${col.suffix ?? ""}`;
}

export function orderColumns(cols: ColumnDef[]): ColumnDef[] {
  const visible = cols.filter((c) => !c.hide);
  return [
    ...visible.filter((c) => c.pinned === "left"),
    ...visible.filter((c) => !c.pinned),
    ...visible.filter((c) => c.pinned === "right"),
  ];
}

export interface TableRendererProps {
  records: Record<string, unknown>[];
  columnsDefs: ColumnDef[] | null;
}

const helper = createColumnHelper<Record<string, unknown>>();

export default function TableRenderer({ records, columnsDefs }: TableRendererProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const cols = useMemo(() => {
    const defs =
      columnsDefs && columnsDefs.length > 0
        ? orderColumns(columnsDefs)
        : Object.keys(records[0] ?? {}).map((field): ColumnDef => ({ field }));
    return defs.map((def) =>
      helper.accessor((row) => row[def.field], {
        id: def.field,
        header: def.headerName ?? def.field,
        cell: (info) => formatCell(info.getValue(), def),
        meta: def,
      })
    );
  }, [columnsDefs, records]);

  const table = useReactTable({
    data: records,
    columns: cols,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const def = h.column.columnDef.meta as ColumnDef;
                return (
                  <th
                    key={h.id}
                    title={def.headerTooltip}
                    style={{
                      width: def.width,
                      minWidth: def.minWidth,
                      maxWidth: def.maxWidth,
                    }}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[
                      h.column.getIsSorted() as string
                    ] ?? ""}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm vitest run src/components/renderers/TableRenderer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 9: Implement `RawJsonView` and `WidgetBody`, wire into `WidgetCard`**

`src/components/renderers/RawJsonView.tsx`:

```tsx
export default function RawJsonView({ data }: { data: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  return <pre className="raw-json">{text}</pre>;
}
```

`src/components/WidgetBody.tsx`:

```tsx
import type {
  BackendConfig, CardView, ParamValues, WidgetDef,
} from "../lib/types";
import { useWidgetData } from "../hooks/useWidgetData";
import RawJsonView from "./renderers/RawJsonView";
import TableRenderer from "./renderers/TableRenderer";

export interface WidgetBodyProps {
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  view: CardView;
  refreshKey: number;
  onRetry(): void;
}

function isRecordArray(x: unknown): x is Record<string, unknown>[] {
  return (
    Array.isArray(x) &&
    (x.length === 0 || (typeof x[0] === "object" && x[0] !== null))
  );
}

export default function WidgetBody({
  widget, backend, values, view, refreshKey, onRetry,
}: WidgetBodyProps) {
  const { status, data, error } = useWidgetData(
    backend, widget, values, { raw: view === "raw" }, refreshKey
  );

  if (status === "loading") {
    return <div className="card-loading">Loading…</div>;
  }
  if (status === "error") {
    return (
      <div className="error-box">
        <p>{error}</p>
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }

  // raw view: always table-or-json over the raw records
  if (view === "raw") {
    return isRecordArray(data)
      ? <TableRenderer records={data} columnsDefs={null} />
      : <RawJsonView data={data} />;
  }

  switch (widget.type) {
    // chart (Task 11), html/iframe/markdown/metric/unsupported (Task 12)
    // replace branches of this switch.
    case "table":
    default:
      if (isRecordArray(data)) {
        return <TableRenderer records={data} columnsDefs={widget.columnsDefs} />;
      }
      return <RawJsonView data={data} />; // malformed shape -> raw JSON fallback
  }
}
```

In `src/components/WidgetCard.tsx`, add imports and replace the body `<pre>`:

```tsx
import WidgetBody from "./WidgetBody";
```

```tsx
      <div className="card-body">
        <WidgetBody
          widget={widget}
          backend={backend}
          values={values}
          view={card.view}
          refreshKey={refreshKey}
          onRetry={() => setRefreshKey((k) => k + 1)}
        />
      </div>
```

- [ ] **Step 10: Append table styles to `src/styles.css`**

```css
/* ---- data table ---- */
.table-wrap { height: 100%; overflow: auto; }
.data-table { border-collapse: collapse; width: 100%; font-size: 12px; }
.data-table th {
  position: sticky; top: 0;
  background: var(--bg-panel);
  text-align: left; padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  cursor: pointer; user-select: none; white-space: nowrap;
}
.data-table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.card-loading { padding: 12px; color: var(--text-dim); }
```

- [ ] **Step 11: Verify manually against the live NAS**

Run: `pnpm tauri dev`
On the "Historical" card, set Symbol to "AAPL": a sortable table of live OHLCV rows renders with Date pinned first, formatted numbers (volume with thousands separators), header tooltips. Click a header to sort. Break it: set Symbol to "NOTATICKER" — an inline error with a Retry button appears (never a blank card), and the error is appended to `~/Library/Application Support/com.<owner>.openbb-desk/logs/openbb-desk.log`.

- [ ] **Step 12: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: widget data hook, TanStack table renderer with columnsDefs formatting, raw JSON fallback"
```

---
### Task 11: Chart renderer (Plotly figures + generated candlestick/line) and table↔chart toggle

**Files:**
- Create: `$REPO_ROOT/src/lib/chartShapes.ts`
- Test: `$REPO_ROOT/src/lib/chartShapes.test.ts`
- Create: `$REPO_ROOT/src/components/renderers/ChartRenderer.tsx`
- Modify: `$REPO_ROOT/src/components/WidgetBody.tsx` (chart branches)
- Modify: `$REPO_ROOT/src/components/WidgetCard.tsx` (table↔chart toggle button)
- Modify: `$REPO_ROOT/src/styles.css` (append `.chart-host`)

**Interfaces:**
- Consumes: `WidgetDef`, `ColumnDef` (Task 2); `WidgetBody`/`WidgetCard` (Tasks 9–10); `useDashboardStore.setCardView` (Task 5).
- Produces (used by Tasks 12, 16):
  - `interface PlotlyFigure { data: unknown[]; layout: Record<string, unknown>; config?: Record<string, unknown> }`
  - `isPlotlyFigure(x: unknown): x is PlotlyFigure`
  - `applyDarkLayout(layout: Record<string, unknown>): Record<string, unknown>`
  - `buildFigureFromRecords(records: Record<string, unknown>[]): PlotlyFigure | null` — candlestick when open/high/low/close present, else line over the first numeric column; `null` when no date/time column.
  - `canToggleChart(widget: WidgetDef): boolean`
  - `ChartRenderer` props: `{ figure: PlotlyFigure }` (default export; renders via plotly.js-dist-min).

- [ ] **Step 1: Write the failing test** — `src/lib/chartShapes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import historical from "../test/fixtures/historical.fixture.json";
import type { WidgetDef } from "./types";
import {
  applyDarkLayout, buildFigureFromRecords, canToggleChart, isPlotlyFigure,
} from "./chartShapes";

describe("isPlotlyFigure", () => {
  it("detects OpenBB charting figure JSON", () => {
    expect(isPlotlyFigure({ data: [{ type: "scatter" }], layout: {} })).toBe(true);
    expect(isPlotlyFigure({ data: "nope", layout: {} })).toBe(false);
    expect(isPlotlyFigure(historical.results)).toBe(false);
    expect(isPlotlyFigure(null)).toBe(false);
  });
});

describe("buildFigureFromRecords", () => {
  it("builds a candlestick when OHLC columns are present", () => {
    const fig = buildFigureFromRecords(historical.results)!;
    expect(fig).not.toBeNull();
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("candlestick");
    expect(trace.x).toEqual(["2026-07-01", "2026-07-02", "2026-07-06"]);
    expect(trace.close).toEqual([294.38, 308.63, 312.66]);
  });

  it("builds a line for non-OHLC time series", () => {
    const fig = buildFigureFromRecords([
      { date: "2026-01-01", value: 1 },
      { date: "2026-01-02", value: 2 },
    ])!;
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("scatter");
    expect(trace.y).toEqual([1, 2]);
  });

  it("returns null without a date/time column", () => {
    expect(buildFigureFromRecords([{ a: 1, b: 2 }])).toBeNull();
    expect(buildFigureFromRecords([])).toBeNull();
  });
});

describe("applyDarkLayout", () => {
  it("adds dark colors and keeps caller keys", () => {
    const out = applyDarkLayout({ title: "T" });
    expect(out.title).toBe("T");
    expect(out.paper_bgcolor).toBe("#1a212b");
    expect(out.plot_bgcolor).toBe("#1a212b");
  });
});

describe("canToggleChart", () => {
  const base = {
    id: "w", name: "W", description: "", category: "C", subCategory: null,
    endpoint: "/x", gridData: { w: 20, h: 10 }, source: [], runButton: false,
    raw: false, refetchInterval: null, params: [], dataKey: null, mcpUrl: null,
  };
  it("is true for chart widgets and date-columned tables", () => {
    expect(canToggleChart({ ...base, type: "chart", columnsDefs: null } as WidgetDef)).toBe(true);
    expect(
      canToggleChart({
        ...base, type: "table",
        columnsDefs: [{ field: "date", cellDataType: "date" }, { field: "close" }],
      } as WidgetDef)
    ).toBe(true);
    expect(canToggleChart({ ...base, type: "table", columnsDefs: null } as WidgetDef)).toBe(false);
    expect(canToggleChart({ ...base, type: "html", columnsDefs: null } as WidgetDef)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/chartShapes.test.ts`
Expected: FAIL — `Cannot find module './chartShapes'`.

- [ ] **Step 3: Implement `src/lib/chartShapes.ts`** (pure module — no plotly import, so tests stay light)

```ts
import type { WidgetDef } from "./types";

export interface PlotlyFigure {
  data: unknown[];
  layout: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export function isPlotlyFigure(x: unknown): x is PlotlyFigure {
  return (
    x !== null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Array.isArray((x as Record<string, unknown>).data) &&
    typeof (x as Record<string, unknown>).layout === "object"
  );
}

export function applyDarkLayout(
  layout: Record<string, unknown>
): Record<string, unknown> {
  return {
    paper_bgcolor: "#1a212b",
    plot_bgcolor: "#1a212b",
    font: { color: "#d8dee9", size: 11 },
    margin: { l: 48, r: 16, t: 24, b: 32 },
    xaxis: { gridcolor: "#2a3441", ...(layout.xaxis as object ?? {}) },
    yaxis: { gridcolor: "#2a3441", ...(layout.yaxis as object ?? {}) },
    ...layout,
  };
}

const DATE_KEYS = ["date", "datetime", "timestamp", "time"];
const OHLC = ["open", "high", "low", "close"];

export function buildFigureFromRecords(
  records: Record<string, unknown>[]
): PlotlyFigure | null {
  if (records.length === 0) return null;
  const keys = Object.keys(records[0]);
  const dateKey = DATE_KEYS.find((k) => keys.includes(k));
  if (!dateKey) return null;
  const x = records.map((r) => r[dateKey]);
  if (OHLC.every((k) => keys.includes(k))) {
    return {
      data: [{
        type: "candlestick",
        x,
        open: records.map((r) => r.open),
        high: records.map((r) => r.high),
        low: records.map((r) => r.low),
        close: records.map((r) => r.close),
        increasing: { line: { color: "#5fb87a" } },
        decreasing: { line: { color: "#d9695f" } },
      }],
      layout: { xaxis: { rangeslider: { visible: false } } },
    };
  }
  const numKey = keys.find(
    (k) => k !== dateKey && typeof records[0][k] === "number"
  );
  if (!numKey) return null;
  return {
    data: [{
      type: "scatter",
      mode: "lines",
      x,
      y: records.map((r) => r[numKey]),
      line: { color: "#4f8cc9" },
      name: numKey,
    }],
    layout: {},
  };
}

export function canToggleChart(widget: WidgetDef): boolean {
  if (widget.type === "chart") return true;
  if (widget.type !== "table") return false;
  return (
    widget.columnsDefs?.some(
      (c) => c.cellDataType === "date" || DATE_KEYS.includes(c.field)
    ) ?? false
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/chartShapes.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Implement `src/components/renderers/ChartRenderer.tsx`** (not unit-tested — plotly cannot run under jsdom; verified manually in Step 8)

```tsx
import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import { applyDarkLayout, type PlotlyFigure } from "../../lib/chartShapes";

export default function ChartRenderer({ figure }: { figure: PlotlyFigure }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    void Plotly.react(el, figure.data, applyDarkLayout(figure.layout ?? {}), {
      responsive: true,
      displaylogo: false,
      ...(figure.config ?? {}),
    });
    return () => Plotly.purge(el);
  }, [figure]);

  return <div ref={ref} className="chart-host" />;
}
```

Append to `src/styles.css`:

```css
.chart-host { height: 100%; width: 100%; }
```

- [ ] **Step 6: Add chart branches to `src/components/WidgetBody.tsx`**

Add imports at the top:

```tsx
import ChartRenderer from "./renderers/ChartRenderer";
import {
  buildFigureFromRecords, isPlotlyFigure,
} from "../lib/chartShapes";
```

Replace the `switch (widget.type)` block (keep everything above it) with:

```tsx
  if (widget.type === "chart") {
    // OpenBB charting endpoints return Plotly figure JSON (via dataKey chart.content)
    if (isPlotlyFigure(data)) return <ChartRenderer figure={data} />;
    if (isRecordArray(data)) {
      const fig = buildFigureFromRecords(data);
      if (fig) return <ChartRenderer figure={fig} />;
    }
    return <RawJsonView data={data} />;
  }

  if (view === "chart") {
    // generated chart over table-shaped time series
    if (isRecordArray(data)) {
      const fig = buildFigureFromRecords(data);
      if (fig) return <ChartRenderer figure={fig} />;
    }
    if (isPlotlyFigure(data)) return <ChartRenderer figure={data} />;
    return <RawJsonView data={data} />;
  }

  switch (widget.type) {
    // html/iframe/markdown/metric/unsupported branches arrive in Task 12
    case "table":
    default:
      if (isRecordArray(data)) {
        return <TableRenderer records={data} columnsDefs={widget.columnsDefs} />;
      }
      return <RawJsonView data={data} />; // malformed shape -> raw JSON fallback
  }
```

- [ ] **Step 7: Add the table↔chart toggle to `src/components/WidgetCard.tsx`**

Add imports:

```tsx
import { canToggleChart } from "../lib/chartShapes";
```

Add `setCardView` next to the other store selectors:

```tsx
  const setCardView = useDashboardStore((s) => s.setCardView);
```

In the `card-actions` span, insert BEFORE the Refresh button:

```tsx
          {canToggleChart(widget) && widget.type !== "chart" && (
            <button
              title="Toggle table/chart view"
              onClick={() =>
                void setCardView(
                  card.uuid,
                  card.view === "chart" ? "default" : "chart"
                )
              }
            >
              {card.view === "chart" ? "Table" : "Chart"}
            </button>
          )}
```

- [ ] **Step 8: Verify manually against the live NAS**

Run: `pnpm tauri dev`
1. Add "Historical (Chart)" (Equity, type chart) from the library, set Symbol "AAPL": a dark-themed candlestick figure from `openbb-charting` renders (native Plotly figure path).
2. On the plain "Historical" table card, click "Chart": a generated candlestick appears (table-shaped OHLC path); click "Table" to go back. The chosen view persists across app restarts.
3. Resize the card: the chart resizes responsively.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: plotly chart renderer for figure JSON and generated candlestick/line with view toggle"
```

---

### Task 12: HTML, iframe, markdown, metric, unsupported renderers + raw-data toggle

**Files:**
- Create: `$REPO_ROOT/src/components/renderers/HtmlRenderer.tsx`
- Create: `$REPO_ROOT/src/components/renderers/IframeRenderer.tsx`
- Create: `$REPO_ROOT/src/components/renderers/MarkdownRenderer.tsx`
- Create: `$REPO_ROOT/src/components/renderers/MetricRenderer.tsx`
- Create: `$REPO_ROOT/src/components/renderers/UnsupportedRenderer.tsx`
- Test: `$REPO_ROOT/src/components/renderers/renderers.test.tsx`
- Modify: `$REPO_ROOT/src/components/WidgetBody.tsx` (final branch table)
- Modify: `$REPO_ROOT/src/components/WidgetCard.tsx` (raw toggle button)
- Modify: `$REPO_ROOT/src/styles.css` (append frame/metric styles)

**Interfaces:**
- Consumes: everything from Tasks 9–11; `logOnce` (Task 4).
- Produces:
  - `HtmlRenderer` props `{ html: string }` — sandboxed srcdoc iframe, **JS enabled**: `sandbox="allow-scripts allow-forms allow-popups"` (no `allow-same-origin`: srcdoc + same-origin would let widget JS reach the app DOM).
  - `IframeRenderer` props `{ src: string }` — `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` (remote origin needs its own storage/cookies to work, e.g. Streamlit).
  - `MarkdownRenderer` props `{ markdown: string }` (react-markdown).
  - `MetricRenderer` props `{ metric: { label: string; value: string | number; delta?: string | number } }`; also exports `isMetric(x: unknown): x is { label: string; value: string | number; delta?: string | number }`.
  - `UnsupportedRenderer` props `{ type: string }`.
  - `WidgetCard` gains the Raw toggle (shown when `widget.raw === true`), switching `card.view` between `"raw"` and the widget's rendered view.

- [ ] **Step 1: Write the failing test** — `src/components/renderers/renderers.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

import HtmlRenderer from "./HtmlRenderer";
import IframeRenderer from "./IframeRenderer";
import MarkdownRenderer from "./MarkdownRenderer";
import MetricRenderer, { isMetric } from "./MetricRenderer";
import UnsupportedRenderer from "./UnsupportedRenderer";

describe("HtmlRenderer", () => {
  it("renders srcdoc iframe with JS enabled but not same-origin", () => {
    render(<HtmlRenderer html="<b>hello</b>" />);
    const frame = screen.getByTitle("widget-html") as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toBe("<b>hello</b>");
    const sandbox = frame.getAttribute("sandbox")!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });
});

describe("IframeRenderer", () => {
  it("uses the endpoint URL verbatim as src with same-origin allowed", () => {
    render(<IframeRenderer src="http://localhost:8501" />);
    const frame = screen.getByTitle("widget-iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe("http://localhost:8501");
    const sandbox = frame.getAttribute("sandbox")!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
  });
});

describe("MarkdownRenderer", () => {
  it("renders markdown to HTML", () => {
    render(<MarkdownRenderer markdown={"# Title\n\nbody **bold**"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });
});

describe("MetricRenderer", () => {
  it("guards shape and renders label/value/delta", () => {
    expect(isMetric({ label: "AUM", value: "1.2B", delta: "+3%" })).toBe(true);
    expect(isMetric({ value: 1 })).toBe(false);
    expect(isMetric(null)).toBe(false);
    render(<MetricRenderer metric={{ label: "AUM", value: "1.2B", delta: "+3%" }} />);
    expect(screen.getByText("AUM")).toBeInTheDocument();
    expect(screen.getByText("1.2B")).toBeInTheDocument();
    expect(screen.getByText("+3%")).toBeInTheDocument();
  });
});

describe("UnsupportedRenderer", () => {
  it("names the unsupported type", () => {
    render(<UnsupportedRenderer type="pdf" />);
    expect(
      screen.getByText(/type "pdf" is not supported in OpenBB Desk v1/)
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/renderers/renderers.test.tsx`
Expected: FAIL — cannot find the five renderer modules.

- [ ] **Step 3: Implement the five renderers**

`src/components/renderers/HtmlRenderer.tsx`:

```tsx
export default function HtmlRenderer({ html }: { html: string }) {
  return (
    <iframe
      className="widget-frame"
      title="widget-html"
      sandbox="allow-scripts allow-forms allow-popups"
      srcDoc={html}
    />
  );
}
```

`src/components/renderers/IframeRenderer.tsx`:

```tsx
export default function IframeRenderer({ src }: { src: string }) {
  return (
    <iframe
      className="widget-frame"
      title="widget-iframe"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      src={src}
    />
  );
}
```

`src/components/renderers/MarkdownRenderer.tsx`:

```tsx
import ReactMarkdown from "react-markdown";

export default function MarkdownRenderer({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown>{markdown}</ReactMarkdown>
    </div>
  );
}
```

`src/components/renderers/MetricRenderer.tsx`:

```tsx
export interface Metric {
  label: string;
  value: string | number;
  delta?: string | number;
}

export function isMetric(x: unknown): x is Metric {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as Record<string, unknown>).label === "string" &&
    ["string", "number"].includes(typeof (x as Record<string, unknown>).value)
  );
}

export default function MetricRenderer({ metric }: { metric: Metric }) {
  return (
    <div className="metric-box">
      <div className="metric-label">{metric.label}</div>
      <div className="metric-value">{metric.value}</div>
      {metric.delta !== undefined && (
        <div className="metric-delta">{metric.delta}</div>
      )}
    </div>
  );
}
```

`src/components/renderers/UnsupportedRenderer.tsx`:

```tsx
import { logOnce } from "../../lib/logger";

export default function UnsupportedRenderer({ type }: { type: string }) {
  logOnce(
    `widget-type-${type}`,
    `Widget type "${type}" is not supported in OpenBB Desk v1`
  );
  return (
    <div className="error-box">
      Widget type "{type}" is not supported in OpenBB Desk v1.
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/components/renderers/renderers.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Final `src/components/WidgetBody.tsx`** (replace the whole file — this is the complete branch table)

```tsx
import type {
  BackendConfig, CardView, ParamValues, WidgetDef,
} from "../lib/types";
import { useWidgetData } from "../hooks/useWidgetData";
import {
  buildFigureFromRecords, isPlotlyFigure,
} from "../lib/chartShapes";
import ChartRenderer from "./renderers/ChartRenderer";
import HtmlRenderer from "./renderers/HtmlRenderer";
import IframeRenderer from "./renderers/IframeRenderer";
import MarkdownRenderer from "./renderers/MarkdownRenderer";
import MetricRenderer, { isMetric } from "./renderers/MetricRenderer";
import RawJsonView from "./renderers/RawJsonView";
import TableRenderer from "./renderers/TableRenderer";
import UnsupportedRenderer from "./renderers/UnsupportedRenderer";

export interface WidgetBodyProps {
  widget: WidgetDef;
  backend: BackendConfig;
  values: ParamValues;
  view: CardView;
  refreshKey: number;
  onRetry(): void;
}

function isRecordArray(x: unknown): x is Record<string, unknown>[] {
  return (
    Array.isArray(x) &&
    (x.length === 0 || (typeof x[0] === "object" && x[0] !== null))
  );
}

export default function WidgetBody({
  widget, backend, values, view, refreshKey, onRetry,
}: WidgetBodyProps) {
  const { status, data, error } = useWidgetData(
    backend, widget, values, { raw: view === "raw" }, refreshKey
  );

  if (status === "loading") {
    return <div className="card-loading">Loading…</div>;
  }
  if (status === "error") {
    return (
      <div className="error-box">
        <p>{error}</p>
        <button onClick={onRetry}>Retry</button>
      </div>
    );
  }

  if (view === "raw") {
    // ?raw=true JSON view (html widgets included) — table when tabular
    return isRecordArray(data)
      ? <TableRenderer records={data} columnsDefs={null} />
      : <RawJsonView data={data} />;
  }

  if (widget.type === "chart") {
    if (isPlotlyFigure(data)) return <ChartRenderer figure={data} />;
    if (isRecordArray(data)) {
      const fig = buildFigureFromRecords(data);
      if (fig) return <ChartRenderer figure={fig} />;
    }
    return <RawJsonView data={data} />;
  }

  if (view === "chart") {
    if (isRecordArray(data)) {
      const fig = buildFigureFromRecords(data);
      if (fig) return <ChartRenderer figure={fig} />;
    }
    if (isPlotlyFigure(data)) return <ChartRenderer figure={data} />;
    return <RawJsonView data={data} />;
  }

  switch (widget.type) {
    case "html":
      return typeof data === "string"
        ? <HtmlRenderer html={data} />
        : <RawJsonView data={data} />;
    case "iframe":
      return <IframeRenderer src={widget.endpoint} />;
    case "markdown":
      // endpoint returns a JSON-encoded markdown string
      return typeof data === "string"
        ? <MarkdownRenderer markdown={data} />
        : <RawJsonView data={data} />;
    case "metric":
      return isMetric(data)
        ? <MetricRenderer metric={data} />
        : <RawJsonView data={data} />;
    case "multi_file_viewer":
    case "pdf":
      return <UnsupportedRenderer type={widget.type} />;
    case "table":
    default:
      if (isRecordArray(data)) {
        return <TableRenderer records={data} columnsDefs={widget.columnsDefs} />;
      }
      return <RawJsonView data={data} />; // malformed shape -> raw JSON fallback
  }
}
```

- [ ] **Step 6: Add the Raw toggle to `src/components/WidgetCard.tsx`**

In the `card-actions` span, insert AFTER the chart toggle and BEFORE Refresh:

```tsx
          {widget.raw && (
            <button
              title="Toggle raw data view (?raw=true)"
              onClick={() =>
                void setCardView(
                  card.uuid,
                  card.view === "raw"
                    ? widget.type === "chart" ? "chart" : "default"
                    : "raw"
                )
              }
            >
              {card.view === "raw" ? "Rendered" : "Raw"}
            </button>
          )}
```

- [ ] **Step 7: Append styles to `src/styles.css`**

```css
/* ---- html/iframe/metric/markdown renderers ---- */
.widget-frame { width: 100%; height: 100%; border: none; background: #fff; }
.markdown-body { padding: 8px 12px; }
.metric-box {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 4px;
}
.metric-label { color: var(--text-dim); }
.metric-value { font-size: 28px; font-weight: 700; }
.metric-delta { color: var(--accent); }
```

- [ ] **Step 8: Verify manually against the live NAS**

Run: `pnpm tauri dev`
1. Add "IMF Presentation Table" (type html): pick a Dataflow — the card renders server-generated HTML **with working JavaScript interactivity** (interact with the table inside the frame; theme is dark because `theme=dark` is on the query string).
2. Click "Raw" on that card (it declares `raw: true`): the body switches to the `?raw=true` JSON-as-table view; "Rendered" switches back. (Spec criterion 5a.)
3. iframe type: no NAS example exists — temporary check: `python3 -m http.server 8501` locally, then add a widgets.json entry is not possible live; instead verify the IframeRenderer unit test covers src/sandbox and rely on Task 15's fixture round-trip for `storage.mcpUrl`. If a live check is wanted, run a local Streamlit app on :8501 and temporarily add `"http://localhost:8501/*"` to the http scope in `src-tauri/capabilities/default.json` plus a fixture entry served by a test backend. (Optional; unit tests are the gate here.)
4. Add any markdown-type widget (search "markdown" in the library, e.g. an economy calendar note widget) and confirm it renders; add a pdf/multi_file_viewer widget and confirm the "not supported in OpenBB Desk v1" card.

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: html/iframe/markdown/metric/unsupported renderers with raw-data toggle"
```

---
### Task 13: Agent protocol types + SSE stream parser (openbb-ai v2.1.0)

**Files:**
- Create: `$REPO_ROOT/src/lib/agent/types.ts`
- Create: `$REPO_ROOT/src/lib/agent/sse.ts`
- Create: `$REPO_ROOT/src/test/fixtures/rita-stream.fixture.ts`
- Test: `$REPO_ROOT/src/lib/agent/sse.test.ts`

**Interfaces:**
- Consumes: nothing app-side (protocol layer is standalone).
- Produces (used by Tasks 14, 15, 16) — all from `src/lib/agent/types.ts` unless noted:
  - Message types: `HumanMessage`, `AiTextMessage`, `AiFunctionCallMessage`, `ToolResultMessage { role: "tool"; function; input_arguments; data: (DataContent | ToolError)[]; extra_state }`, `ChatMessage` (union), `DataContent { items: DataContentItem[] }`, `DataContentItem { content: string; data_format: { data_type: "object"; parse_as: "table" }; citable: boolean }`, `ToolError { error_type: string; content: string }`
  - Discovery: `AgentInfo { name; description; image?; endpoints: { query: string }; features: Record<string, boolean | AgentFeatureOption> }`, `AgentFeatureOption { label; type: "select"; default: string; options: { label: string; value: string }[] }`, `AgentsJson = Record<string, AgentInfo>`
  - Request: `QueryRequest { messages; widgets: { primary: WidgetRef[]; secondary: WidgetRef[]; extra: WidgetRef[] }; context: null; urls: null; timezone: string; workspace_options: Record<string, unknown>; tools: AgentTool[] | null }`, `WidgetRef { uuid; origin; widget_id; name; description; params: WidgetParamRef[]; metadata }`, `WidgetParamRef { name; type: "text"; description; current_value; default_value }`, `AgentTool { server_id; name; url; endpoint; description; input_schema; auth_token? }`
  - Events: `StatusUpdate`, `ClientArtifact`, `FunctionCallEvent { function; input_arguments; extra_state? }`, `AgentEvent` (discriminated union on `kind`: `"chunk" | "status" | "artifact" | "citations" | "suggestions" | "functionCall"`)
  - From `src/lib/agent/sse.ts`: `SseEvent { event: string; data: unknown }`, `sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent>`, `toAgentEvent(ev: SseEvent): AgentEvent | null`
  - From the fixture: `textStream: string`, `functionCallStream: string`, `artifactStream: string`, `streamOf(text: string, chunkSize?: number): ReadableStream<Uint8Array>`

- [ ] **Step 1: Write `src/lib/agent/types.ts`** (types only — pinned to openbb-ai v2.1.0 wire shapes)

```ts
// OpenBB custom-agent protocol, pinned to openbb-ai v2.1.0.

// ---- discovery (agents.json) ----
export interface AgentFeatureOption {
  label: string;
  type: "select";
  default: string;
  options: { label: string; value: string }[];
}

export interface AgentInfo {
  name: string;
  description: string;
  image?: string;
  endpoints: { query: string };
  features: Record<string, boolean | AgentFeatureOption>;
}

export type AgentsJson = Record<string, AgentInfo>;

// ---- conversation messages ----
export interface HumanMessage { role: "human"; content: string; }
export interface AiTextMessage { role: "ai"; content: string; }
export interface AiFunctionCallMessage {
  role: "ai";
  content: { function: string; input_arguments: Record<string, unknown> };
}

export interface DataContentItem {
  /** JSON string of records */
  content: string;
  data_format: { data_type: "object"; parse_as: "table" };
  citable: boolean;
}
export interface DataContent { items: DataContentItem[]; }
export interface ToolError { error_type: string; content: string; }

export interface ToolResultMessage {
  role: "tool";
  function: string;
  input_arguments: Record<string, unknown>;
  data: (DataContent | ToolError)[];
  /** round-tripped verbatim from the copilotFunctionCall event */
  extra_state: Record<string, unknown>;
}

export type ChatMessage =
  | HumanMessage
  | AiTextMessage
  | AiFunctionCallMessage
  | ToolResultMessage;

// ---- request ----
export interface WidgetParamRef {
  name: string;
  type: "text";
  description: string;
  current_value: unknown;
  default_value: unknown;
}

export interface WidgetRef {
  uuid: string;
  origin: string;
  widget_id: string;
  name: string;
  description: string;
  params: WidgetParamRef[];
  metadata: Record<string, unknown>;
}

export interface AgentTool {
  server_id: string;
  name: string;
  url: string;
  endpoint: string;
  description: string;
  input_schema: Record<string, unknown>;
  auth_token?: string;
}

export interface QueryRequest {
  messages: ChatMessage[];
  widgets: { primary: WidgetRef[]; secondary: WidgetRef[]; extra: WidgetRef[] };
  context: null;
  urls: null;
  timezone: string;
  workspace_options: Record<string, unknown>;
  tools: AgentTool[] | null;
}

// ---- SSE events ----
export interface StatusUpdate {
  eventType: "INFO" | "WARNING" | "ERROR";
  message: string;
  group?: string;
  details?: unknown;
  hidden?: boolean;
}

export interface ClientArtifact {
  type: "text" | "table" | "chart" | "html";
  name: string;
  description: string;
  uuid: string;
  content: string | Record<string, unknown>[];
  chart_params?: Record<string, unknown>;
}

export interface FunctionCallEvent {
  function: string;
  input_arguments: Record<string, unknown>;
  extra_state?: Record<string, unknown>;
}

export type AgentEvent =
  | { kind: "chunk"; delta: string }
  | { kind: "status"; status: StatusUpdate }
  | { kind: "artifact"; artifact: ClientArtifact }
  | { kind: "citations"; citations: unknown[] }
  | { kind: "suggestions"; suggestions: string[] }
  | { kind: "functionCall"; call: FunctionCallEvent };
```

- [ ] **Step 2: Write `src/test/fixtures/rita-stream.fixture.ts`** (recorded-shape Rita streams; standard `event:`/`data:` SSE framing)

```ts
export const textStream =
  [
    "event: copilotStatusUpdate",
    'data: {"eventType":"INFO","message":"Reasoning about your question","group":"reasoning"}',
    "",
    "event: copilotMessageChunk",
    'data: {"delta":"AAPL closed"}',
    "",
    "event: copilotMessageChunk",
    'data: {"delta":" at 294.38 on 2026-07-01."}',
    "",
    "event: copilotPromptSuggestions",
    'data: {"suggestions":["Show the last 5 days","Chart it"]}',
    "",
  ].join("\n") + "\n";

export const functionCallStream =
  [
    "event: copilotStatusUpdate",
    'data: {"eventType":"INFO","message":"Fetching widget data","group":"tools"}',
    "",
    "event: copilotFunctionCall",
    'data: {"function":"get_widget_data","input_arguments":{"data_sources":[{"widget_uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","origin":"OpenBB NAS","id":"equity_price_historical_eodhd_obb","input_args":{"symbol":"AAPL"}}]},"extra_state":{"copilot_function_call_arguments":{"trace":"xyz"}}}',
    "",
  ].join("\n") + "\n";

export const artifactStream =
  [
    "event: copilotMessageArtifact",
    'data: {"type":"table","name":"AAPL last 3 days","description":"OHLCV","uuid":"11111111-2222-4333-8444-555555555555","content":[{"date":"2026-07-01","close":294.38},{"date":"2026-07-02","close":308.63}]}',
    "",
    "event: copilotCitationCollection",
    'data: {"citations":[{"source":"equity_price_historical_eodhd_obb"}]}',
    "",
    "event: copilotMessageChunk",
    'data: {"delta":"Here is the table."}',
    "",
  ].join("\n") + "\n";

export function streamOf(
  text: string,
  chunkSize = 7
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}
```

- [ ] **Step 3: Write the failing test** — `src/lib/agent/sse.test.ts`

```ts
import { describe, expect, it } from "vitest";
import {
  artifactStream, functionCallStream, streamOf, textStream,
} from "../../test/fixtures/rita-stream.fixture";
import { sseEvents, toAgentEvent, type SseEvent } from "./sse";

async function collect(text: string, chunkSize = 7): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of sseEvents(streamOf(text, chunkSize))) out.push(ev);
  return out;
}

describe("sseEvents", () => {
  it("parses events split across tiny chunks", async () => {
    const events = await collect(textStream, 3);
    expect(events.map((e) => e.event)).toEqual([
      "copilotStatusUpdate",
      "copilotMessageChunk",
      "copilotMessageChunk",
      "copilotPromptSuggestions",
    ]);
    expect(events[1].data).toEqual({ delta: "AAPL closed" });
  });

  it("handles CRLF framing and non-JSON data", async () => {
    const events = await collect(
      "event: copilotMessageChunk\r\ndata: not json\r\n\r\n"
    );
    expect(events).toEqual([
      { event: "copilotMessageChunk", data: "not json" },
    ]);
  });

  it("joins multi-line data fields and defaults the event name", async () => {
    const events = await collect('data: {"a":\ndata: 1}\n\n');
    expect(events).toEqual([{ event: "message", data: { a: 1 } }]);
  });

  it("ignores comment and id lines", async () => {
    const events = await collect(
      ': keepalive\nid: 4\nevent: copilotMessageChunk\ndata: {"delta":"x"}\n\n'
    );
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ delta: "x" });
  });
});

describe("toAgentEvent", () => {
  it("maps chunk, status, suggestions", async () => {
    const events = (await collect(textStream)).map(toAgentEvent);
    expect(events[0]).toEqual({
      kind: "status",
      status: { eventType: "INFO", message: "Reasoning about your question", group: "reasoning" },
    });
    expect(events[1]).toEqual({ kind: "chunk", delta: "AAPL closed" });
    expect(events[3]).toEqual({
      kind: "suggestions",
      suggestions: ["Show the last 5 days", "Chart it"],
    });
  });

  it("maps the function call with extra_state intact", async () => {
    const events = (await collect(functionCallStream)).map(toAgentEvent);
    expect(events[1]).toMatchObject({
      kind: "functionCall",
      call: {
        function: "get_widget_data",
        extra_state: { copilot_function_call_arguments: { trace: "xyz" } },
      },
    });
  });

  it("maps artifacts and citations; unknown events map to null", async () => {
    const events = (await collect(artifactStream)).map(toAgentEvent);
    expect(events[0]).toMatchObject({
      kind: "artifact",
      artifact: { type: "table", name: "AAPL last 3 days" },
    });
    expect(events[1]).toMatchObject({ kind: "citations" });
    expect(toAgentEvent({ event: "somethingNew", data: {} })).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run src/lib/agent/sse.test.ts`
Expected: FAIL — `Cannot find module './sse'`.

- [ ] **Step 5: Implement `src/lib/agent/sse.ts`**

```ts
import type {
  AgentEvent, ClientArtifact, FunctionCallEvent, StatusUpdate,
} from "./types";

export interface SseEvent {
  event: string;
  data: unknown;
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // ignore comments (":") and other fields (id:, retry:)
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { event, data };
}

/** Standard `event: <name>\ndata: <json>\n\n` framing. */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const ev = parseBlock(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (ev) yield ev;
      }
    }
    const ev = parseBlock(buf);
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}

export function toAgentEvent(ev: SseEvent): AgentEvent | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.event) {
    case "copilotMessageChunk":
      return { kind: "chunk", delta: String(d.delta ?? "") };
    case "copilotStatusUpdate":
      return { kind: "status", status: d as unknown as StatusUpdate };
    case "copilotMessageArtifact":
      return { kind: "artifact", artifact: d as unknown as ClientArtifact };
    case "copilotCitationCollection":
      return {
        kind: "citations",
        citations: Array.isArray(d.citations) ? d.citations : [],
      };
    case "copilotPromptSuggestions":
      return {
        kind: "suggestions",
        suggestions: Array.isArray(d.suggestions)
          ? d.suggestions.map(String)
          : [],
      };
    case "copilotFunctionCall":
      return { kind: "functionCall", call: d as unknown as FunctionCallEvent };
    default:
      return null;
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run src/lib/agent/sse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 7: Commit**

```bash
cd $REPO_ROOT
git add src/lib/agent/ src/test/fixtures/rita-stream.fixture.ts
git commit -m "feat: openbb-ai v2.1.0 agent protocol types and SSE stream parser with fixtures"
```

---

### Task 14: Agent client — query round-trips, get_widget_data, abort

**Files:**
- Create: `$REPO_ROOT/src/lib/agent/agentClient.ts`
- Test: `$REPO_ROOT/src/lib/agent/agentClient.test.ts`

**Interfaces:**
- Consumes: agent types + `sseEvents`/`toAgentEvent` (Task 13); `initialParamValues` (Task 9); `fetchWidgetData` (Task 3); `logError` (Task 4); app types (Task 2).
- Produces (used by Task 16):
  - `fetchAgents(ritaUrl: string): Promise<AgentsJson>` — GET `{ritaUrl}/agents.json` via plugin-http.
  - `interface GetWidgetDataSource { widget_uuid: string; origin: string; id: string; input_args: Record<string, unknown> }`
  - `type WidgetDataFetcher = (source: GetWidgetDataSource) => Promise<string>` (returns a JSON string of records; throws on failure)
  - `buildWidgetRefs(cards: DashboardCard[], lookupWidget: (backendId: string, widgetId: string) => WidgetDef | undefined, backendName: (backendId: string) => string): WidgetRef[]`
  - `makeWidgetDataFetcher(deps: { getCards(): DashboardCard[]; lookupWidget(backendId: string, widgetId: string): WidgetDef | undefined; getBackend(backendId: string): BackendConfig | undefined }): WidgetDataFetcher`
  - `runAgentQuery(opts: RunQueryOptions): Promise<ChatMessage[]>` with `interface RunQueryOptions { queryUrl: string; messages: ChatMessage[]; widgets: WidgetRef[]; tools: AgentTool[] | null; workspaceOptions: Record<string, unknown>; signal: AbortSignal; onEvent(ev: AgentEvent): void; fetchWidgetData: WidgetDataFetcher; fetchImpl?: typeof fetch; maxFunctionRounds?: number }` — returns the full message list (ai echoes, tool results, final ai text appended). **Uses native `window.fetch` by default** (SSE streaming; Rita sends permissive CORS) — the ONLY HTTP in the app not going through plugin-http.

- [ ] **Step 1: Write the failing test** — `src/lib/agent/agentClient.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  functionCallStream, streamOf, textStream,
} from "../../test/fixtures/rita-stream.fixture";
import type { DashboardCard, WidgetDef } from "../types";
import type { AgentEvent, QueryRequest, ToolResultMessage } from "./types";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));
vi.mock("../logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));
// agentClient imports fetchWidgetData from dataClient; ESM exports cannot be
// spied on, so the module is mocked wholesale.
const fetchWidgetDataMock = vi.fn();
vi.mock("../dataClient", () => ({
  fetchWidgetData: (...a: unknown[]) => fetchWidgetDataMock(...a),
}));

import {
  buildWidgetRefs, makeWidgetDataFetcher, runAgentQuery,
} from "./agentClient";

const widget: WidgetDef = {
  id: "equity_price_historical_eodhd_obb", name: "Historical",
  description: "OHLCV", category: "Equity", subCategory: "Price",
  type: "table", endpoint: "/api/v1/equity/price/historical",
  gridData: { w: 40, h: 15 }, source: ["Eodhd"], runButton: false, raw: false,
  refetchInterval: null,
  params: [{
    paramName: "symbol", type: "text", value: null, label: "Symbol",
    description: "Symbol to get data for.", show: true, multiSelect: true,
    options: null, optionsEndpoint: null, optionsParams: null,
  }, {
    paramName: "provider", type: "text", value: "eodhd", label: "provider",
    description: "", show: false, multiSelect: false, options: null,
    optionsEndpoint: null, optionsParams: null,
  }],
  dataKey: "results", columnsDefs: null, mcpUrl: null,
};

const card: DashboardCard = {
  uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  widgetId: widget.id, backendId: "nas",
  layout: { x: 0, y: 0, w: 40, h: 15 },
  params: { symbol: "MSFT" }, view: "default",
};

describe("buildWidgetRefs", () => {
  it("maps cards to protocol Widget objects with current and default values", () => {
    const refs = buildWidgetRefs([card], () => widget, () => "OpenBB NAS");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      uuid: card.uuid,
      origin: "OpenBB NAS",
      widget_id: widget.id,
      name: "Historical",
    });
    const symbol = refs[0].params.find((p) => p.name === "symbol")!;
    expect(symbol).toEqual({
      name: "symbol", type: "text", description: "Symbol to get data for.",
      current_value: "MSFT", default_value: null,
    });
    const provider = refs[0].params.find((p) => p.name === "provider")!;
    expect(provider.current_value).toBe("eodhd");
  });

  it("skips cards whose widget is unknown", () => {
    expect(buildWidgetRefs([card], () => undefined, () => "x")).toEqual([]);
  });
});

describe("runAgentQuery", () => {
  let posts: QueryRequest[];
  let events: AgentEvent[];

  beforeEach(() => {
    posts = [];
    events = [];
  });

  function fakeFetch(streams: string[]): typeof fetch {
    return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(streamOf(streams.shift()!), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  it("streams a plain text answer and appends it to messages", async () => {
    const messages = await runAgentQuery({
      queryUrl: "http://agent-host:8002/v1/query",
      messages: [{ role: "human", content: "How did AAPL close?" }],
      widgets: [], tools: null, workspaceOptions: {},
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      fetchWidgetData: async () => "[]",
      fetchImpl: fakeFetch([textStream]),
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].messages).toEqual([
      { role: "human", content: "How did AAPL close?" },
    ]);
    expect(posts[0].tools).toBeNull();
    expect(typeof posts[0].timezone).toBe("string");
    expect(messages[messages.length - 1]).toEqual({
      role: "ai", content: "AAPL closed at 294.38 on 2026-07-01.",
    });
    expect(events.some((e) => e.kind === "suggestions")).toBe(true);
  });

  it("handles the get_widget_data round trip with extra_state round-tripped", async () => {
    const fetcher = vi.fn(async () => '[{"date":"2026-07-01","close":294.38}]');
    const messages = await runAgentQuery({
      queryUrl: "http://agent-host:8002/v1/query",
      messages: [{ role: "human", content: "Data on my dashboard?" }],
      widgets: [], tools: null, workspaceOptions: {},
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      fetchWidgetData: fetcher,
      fetchImpl: fakeFetch([functionCallStream, textStream]),
    });
    expect(posts).toHaveLength(2); // stream terminated, client re-POSTed
    expect(fetcher).toHaveBeenCalledWith({
      widget_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      origin: "OpenBB NAS",
      id: "equity_price_historical_eodhd_obb",
      input_args: { symbol: "AAPL" },
    });
    const echoed = posts[1].messages[1];
    expect(echoed).toEqual({
      role: "ai",
      content: {
        function: "get_widget_data",
        input_arguments: expect.objectContaining({ data_sources: expect.any(Array) }),
      },
    });
    const tool = posts[1].messages[2] as ToolResultMessage;
    expect(tool.role).toBe("tool");
    expect(tool.function).toBe("get_widget_data");
    expect(tool.extra_state).toEqual({
      copilot_function_call_arguments: { trace: "xyz" },
    });
    expect(tool.data[0]).toEqual({
      items: [{
        content: '[{"date":"2026-07-01","close":294.38}]',
        data_format: { data_type: "object", parse_as: "table" },
        citable: true,
      }],
    });
    expect(messages[messages.length - 1]).toEqual({
      role: "ai", content: "AAPL closed at 294.38 on 2026-07-01.",
    });
  });

  it("answers unknown functions with an unsupported tool result and continues", async () => {
    const unknownFn =
      'event: copilotFunctionCall\ndata: {"function":"do_magic","input_arguments":{}}\n\n';
    await runAgentQuery({
      queryUrl: "http://x/query",
      messages: [{ role: "human", content: "hi" }],
      widgets: [], tools: null, workspaceOptions: {},
      signal: new AbortController().signal,
      onEvent: () => {},
      fetchWidgetData: async () => "[]",
      fetchImpl: fakeFetch([unknownFn, textStream]),
    });
    const tool = posts[1].messages[2] as ToolResultMessage;
    expect(tool.data).toEqual([
      { error_type: "unsupported", content: "Function not supported by OpenBB Desk v1" },
    ]);
  });

  it("passes the abort signal to fetch and surfaces HTTP errors", async () => {
    const ctrl = new AbortController();
    const impl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(ctrl.signal);
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(
      runAgentQuery({
        queryUrl: "http://x/query",
        messages: [{ role: "human", content: "hi" }],
        widgets: [], tools: null, workspaceOptions: {},
        signal: ctrl.signal,
        onEvent: () => {},
        fetchWidgetData: async () => "[]",
        fetchImpl: impl,
      })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("makeWidgetDataFetcher", () => {
  it("resolves widget_uuid against cards and merges input_args over params", async () => {
    fetchWidgetDataMock.mockResolvedValueOnce([{ close: 1 }]);
    const fetcher = makeWidgetDataFetcher({
      getCards: () => [card],
      lookupWidget: () => widget,
      getBackend: () => ({ id: "nas", name: "OpenBB NAS", baseUrl: "http://x" }),
    });
    const out = await fetcher({
      widget_uuid: card.uuid, origin: "OpenBB NAS",
      id: widget.id, input_args: { symbol: "AAPL" },
    });
    expect(out).toBe('[{"close":1}]');
    expect(fetchWidgetDataMock).toHaveBeenCalledWith(
      { id: "nas", name: "OpenBB NAS", baseUrl: "http://x" },
      widget,
      expect.objectContaining({ symbol: "AAPL", provider: "eodhd" }), // input_args win
      {}
    );
  });

  it("throws for an unknown widget_uuid", async () => {
    const fetcher = makeWidgetDataFetcher({
      getCards: () => [], lookupWidget: () => undefined, getBackend: () => undefined,
    });
    await expect(
      fetcher({ widget_uuid: "nope", origin: "x", id: "y", input_args: {} })
    ).rejects.toThrow(/No widget card/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/agent/agentClient.test.ts`
Expected: FAIL — `Cannot find module './agentClient'`.

- [ ] **Step 3: Implement `src/lib/agent/agentClient.ts`**

```ts
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, DashboardCard, ParamValues, WidgetDef } from "../types";
import { fetchWidgetData as fetchWidgetDataHttp } from "../dataClient";
import { initialParamValues } from "../params";
import { sseEvents, toAgentEvent } from "./sse";
import type {
  AgentEvent, AgentTool, AgentsJson, ChatMessage, FunctionCallEvent,
  QueryRequest, ToolResultMessage, WidgetRef,
} from "./types";

export async function fetchAgents(ritaUrl: string): Promise<AgentsJson> {
  const url = `${ritaUrl.replace(/\/+$/, "")}/agents.json`;
  const res = await tauriFetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as AgentsJson;
}

export interface GetWidgetDataSource {
  widget_uuid: string;
  origin: string;
  id: string;
  input_args: Record<string, unknown>;
}

export type WidgetDataFetcher = (source: GetWidgetDataSource) => Promise<string>;

export function buildWidgetRefs(
  cards: DashboardCard[],
  lookupWidget: (backendId: string, widgetId: string) => WidgetDef | undefined,
  backendName: (backendId: string) => string
): WidgetRef[] {
  const out: WidgetRef[] = [];
  for (const card of cards) {
    const w = lookupWidget(card.backendId, card.widgetId);
    if (!w) continue;
    const defaults = initialParamValues(w);
    out.push({
      uuid: card.uuid,
      origin: backendName(card.backendId),
      widget_id: w.id,
      name: w.name,
      description: w.description,
      params: w.params.map((p) => ({
        name: p.paramName,
        type: "text",
        description: p.description,
        current_value: card.params[p.paramName] ?? defaults[p.paramName] ?? null,
        default_value: defaults[p.paramName] ?? null,
      })),
      metadata: {},
    });
  }
  return out;
}

export function makeWidgetDataFetcher(deps: {
  getCards(): DashboardCard[];
  lookupWidget(backendId: string, widgetId: string): WidgetDef | undefined;
  getBackend(backendId: string): BackendConfig | undefined;
}): WidgetDataFetcher {
  return async (src) => {
    const card = deps.getCards().find((c) => c.uuid === src.widget_uuid);
    if (!card) {
      throw new Error(
        `No widget card with uuid ${src.widget_uuid} on the active dashboard`
      );
    }
    const widget = deps.lookupWidget(card.backendId, card.widgetId);
    const backend = deps.getBackend(card.backendId);
    if (!widget || !backend) {
      throw new Error(`Widget ${card.widgetId} unavailable`);
    }
    const values: ParamValues = {
      ...initialParamValues(widget),
      ...card.params,
      ...(src.input_args as ParamValues),
    };
    // html widgets contribute their raw=true JSON, never HTML (spec)
    const data = await fetchWidgetDataHttp(
      backend, widget, values, widget.type === "html" ? { raw: true } : {}
    );
    return JSON.stringify(data);
  };
}

async function executeFunction(
  call: FunctionCallEvent,
  fetchWidgetData: WidgetDataFetcher
): Promise<ToolResultMessage> {
  if (call.function !== "get_widget_data") {
    return {
      role: "tool",
      function: call.function,
      input_arguments: call.input_arguments,
      data: [{
        error_type: "unsupported",
        content: "Function not supported by OpenBB Desk v1",
      }],
      extra_state: call.extra_state ?? {},
    };
  }
  const sources = Array.isArray(call.input_arguments?.data_sources)
    ? (call.input_arguments.data_sources as GetWidgetDataSource[])
    : [];
  const data: ToolResultMessage["data"] = [];
  for (const src of sources) {
    try {
      const content = await fetchWidgetData(src);
      data.push({
        items: [{
          content,
          data_format: { data_type: "object", parse_as: "table" },
          citable: true,
        }],
      });
    } catch (e) {
      data.push({
        error_type: "fetch_failed",
        content: `Failed to fetch widget data: ${String(e)}`,
      });
    }
  }
  return {
    role: "tool",
    function: "get_widget_data",
    input_arguments: call.input_arguments,
    data,
    extra_state: call.extra_state ?? {}, // round-tripped verbatim
  };
}

export interface RunQueryOptions {
  queryUrl: string;
  messages: ChatMessage[];
  widgets: WidgetRef[];
  tools: AgentTool[] | null;
  workspaceOptions: Record<string, unknown>;
  signal: AbortSignal;
  onEvent(ev: AgentEvent): void;
  fetchWidgetData: WidgetDataFetcher;
  /** native fetch by default — SSE streams cannot go through plugin-http */
  fetchImpl?: typeof fetch;
  maxFunctionRounds?: number;
}

export async function runAgentQuery(opts: RunQueryOptions): Promise<ChatMessage[]> {
  const {
    queryUrl, signal, onEvent,
    fetchImpl = fetch, maxFunctionRounds = 5,
  } = opts;
  const messages: ChatMessage[] = [...opts.messages];

  for (let round = 0; round <= maxFunctionRounds; round++) {
    const body: QueryRequest = {
      messages,
      widgets: { primary: opts.widgets, secondary: [], extra: [] },
      context: null,
      urls: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workspace_options: opts.workspaceOptions,
      tools: opts.tools,
    };
    const res = await fetchImpl(queryUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`Rita query failed: HTTP ${res.status} from ${queryUrl}`);
    }

    let assistantText = "";
    let functionCall: FunctionCallEvent | null = null;
    for await (const raw of sseEvents(res.body)) {
      const ev = toAgentEvent(raw);
      if (!ev) continue;
      onEvent(ev);
      if (ev.kind === "chunk") assistantText += ev.delta;
      if (ev.kind === "functionCall") {
        functionCall = ev.call; // a function call TERMINATES the stream
        break;
      }
    }

    if (!functionCall) {
      if (assistantText !== "") {
        messages.push({ role: "ai", content: assistantText });
      }
      return messages;
    }
    messages.push({
      role: "ai",
      content: {
        function: functionCall.function,
        input_arguments: functionCall.input_arguments,
      },
    });
    messages.push(await executeFunction(functionCall, opts.fetchWidgetData));
  }
  throw new Error("Rita exceeded the function-call round limit");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/agent/agentClient.test.ts`
Expected: PASS (8 tests). Then `pnpm vitest run` — whole suite green.

- [ ] **Step 5: Commit**

```bash
cd $REPO_ROOT
git add src/lib/agent/agentClient.ts src/lib/agent/agentClient.test.ts
git commit -m "feat: agent client with SSE query streaming, get_widget_data round trip, abort support"
```

---
### Task 15: MCP discovery client and tool assembly

**Files:**
- Create: `$REPO_ROOT/src/lib/agent/mcp.ts`
- Test: `$REPO_ROOT/src/lib/agent/mcp.test.ts`

**Interfaces:**
- Consumes: `AgentTool` (Task 13); `McpServerConfig` (Task 2); `logError` (Task 4).
- Produces (used by Task 16):
  - `mcpRpc(url: string, method: string, params: Record<string, unknown> | undefined, id: number | null, sessionId?: string | null, fetchImpl?: typeof fetch): Promise<{ result: unknown; sessionId: string | null }>` — JSON-RPC over MCP streamable-http via plugin-http; `id: null` sends a notification; parses both plain-JSON and SSE-framed single-message responses; captures/propagates the `Mcp-Session-Id` header.
  - `discoverMcpTools(serverId: string, url: string, fetchImpl?: typeof fetch): Promise<AgentTool[]>` — initialize → notifications/initialized → tools/list; cached per app session by url.
  - `clearMcpCache(): void`
  - `assembleTools(mcpServers: McpServerConfig[], dashboardMcp: { widgetId: string; url: string }[], fetchImpl?: typeof fetch): Promise<AgentTool[] | null>` — **TOOL ASSEMBLY RULE (spec):** union of (a) enabled Settings MCP servers and (b) `storage.mcpUrl` values of widgets on the ACTIVE dashboard, deduplicated by url; per-server failures are logged and skipped (never block chat); returns `null` when no tools resolved.

- [ ] **Step 1: Write the failing test** — `src/lib/agent/mcp.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

import { assembleTools, clearMcpCache, discoverMcpTools, mcpRpc } from "./mcp";

const TOOLS_RESULT = {
  jsonrpc: "2.0", id: 2,
  result: {
    tools: [{
      name: "equity_price_historical",
      description: "Historical OHLCV",
      inputSchema: { type: "object", properties: { symbol: { type: "string" } } },
    }],
  },
};

function mkFetch(bodies: { body: string; contentType: string; session?: string }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const next = bodies.shift()!;
    return new Response(next.body, {
      status: 200,
      headers: {
        "content-type": next.contentType,
        ...(next.session ? { "Mcp-Session-Id": next.session } : {}),
      },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeEach(() => clearMcpCache());

describe("mcpRpc", () => {
  it("parses SSE-framed single-message responses and captures the session id", async () => {
    const { impl } = mkFetch([{
      body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      contentType: "text/event-stream",
      session: "sess-1",
    }]);
    const out = await mcpRpc("http://mcp/x", "initialize", { a: 1 }, 1, null, impl);
    expect(out.result).toEqual({ ok: true });
    expect(out.sessionId).toBe("sess-1");
  });

  it("raises on JSON-RPC errors", async () => {
    const { impl } = mkFetch([{
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}',
      contentType: "application/json",
    }]);
    await expect(mcpRpc("http://mcp/x", "tools/call", {}, 1, null, impl))
      .rejects.toThrow(/nope/);
  });
});

describe("discoverMcpTools", () => {
  it("runs initialize -> initialized -> tools/list with the session header", async () => {
    const { impl, calls } = mkFetch([
      {
        body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
        contentType: "application/json", session: "sess-9",
      },
      { body: "", contentType: "application/json" },
      { body: JSON.stringify(TOOLS_RESULT), contentType: "application/json" },
    ]);
    const tools = await discoverMcpTools("openbb-mcp", "http://mcp/x", impl);
    expect(tools).toEqual([{
      server_id: "openbb-mcp",
      name: "equity_price_historical",
      url: "http://mcp/x",
      endpoint: "",
      description: "Historical OHLCV",
      input_schema: { type: "object", properties: { symbol: { type: "string" } } },
    }]);
    const init = JSON.parse(String(calls[0].init.body));
    expect(init).toMatchObject({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "openbb-desk", version: "0.1.0" },
      },
    });
    expect(JSON.parse(String(calls[1].init.body)).method).toBe("notifications/initialized");
    const h2 = new Headers(calls[1].init.headers);
    const h3 = new Headers(calls[2].init.headers);
    expect(h2.get("Mcp-Session-Id")).toBe("sess-9");
    expect(h3.get("Mcp-Session-Id")).toBe("sess-9");
  });

  it("caches per url within the session", async () => {
    const { impl } = mkFetch([
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}', contentType: "application/json" },
      { body: "", contentType: "application/json" },
      { body: JSON.stringify(TOOLS_RESULT), contentType: "application/json" },
    ]);
    await discoverMcpTools("s1", "http://mcp/x", impl);
    const again = await discoverMcpTools("s1", "http://mcp/x", impl);
    expect(again).toHaveLength(1);
    expect(impl).toHaveBeenCalledTimes(3); // no extra calls
  });
});

describe("assembleTools", () => {
  it("unions settings servers with dashboard storage.mcpUrl, skipping failures", async () => {
    const { impl } = mkFetch([
      // server A succeeds (3 calls)
      { body: '{"jsonrpc":"2.0","id":1,"result":{}}', contentType: "application/json" },
      { body: "", contentType: "application/json" },
      { body: JSON.stringify(TOOLS_RESULT), contentType: "application/json" },
      // server B (widget mcpUrl) fails on initialize
      { body: "boom", contentType: "text/plain" },
    ]);
    const tools = await assembleTools(
      [
        { id: "openbb-mcp", url: "http://mcp/a", enabled: true },
        { id: "disabled", url: "http://mcp/off", enabled: false },
      ],
      [{ widgetId: "portfolio_iframe", url: "http://mcp/b" }],
      impl
    );
    expect(tools).toHaveLength(1); // A's tool; B skipped, disabled ignored
    expect(tools![0].server_id).toBe("openbb-mcp");
  });

  it("returns null when nothing resolves", async () => {
    const { impl } = mkFetch([{ body: "boom", contentType: "text/plain" }]);
    expect(await assembleTools([{ id: "a", url: "http://mcp/a", enabled: true }], [], impl)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/lib/agent/mcp.test.ts`
Expected: FAIL — `Cannot find module './mcp'`.
(Note the failure-path fetch above returns 200 with unparseable body — `mcpRpc` must throw "unparseable", which `assembleTools` catches.)

- [ ] **Step 3: Implement `src/lib/agent/mcp.ts`**

```ts
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { McpServerConfig } from "../types";
import { logError } from "../logger";
import type { AgentTool } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

function parseRpcBody(text: string, contentType: string): JsonRpcResponse | null {
  // streamable-http servers may frame the single JSON-RPC response as SSE
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        try {
          return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        } catch {
          /* keep scanning */
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(text) as JsonRpcResponse;
  } catch {
    return null;
  }
}

export async function mcpRpc(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number | null,
  sessionId: string | null = null,
  fetchImpl: typeof fetch = tauriFetch
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  if (id !== null) body.id = id;
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`MCP ${method} failed: HTTP ${res.status} from ${url}`);
  }
  const newSession = res.headers.get("Mcp-Session-Id") ?? sessionId;
  if (id === null) return { result: null, sessionId: newSession }; // notification
  const parsed = parseRpcBody(
    await res.text(),
    res.headers.get("content-type") ?? ""
  );
  if (!parsed) throw new Error(`MCP ${method}: unparseable response from ${url}`);
  if (parsed.error) throw new Error(`MCP ${method} error: ${parsed.error.message}`);
  return { result: parsed.result ?? null, sessionId: newSession };
}

const toolCache = new Map<string, AgentTool[]>();

export function clearMcpCache(): void {
  toolCache.clear();
}

export async function discoverMcpTools(
  serverId: string,
  url: string,
  fetchImpl: typeof fetch = tauriFetch
): Promise<AgentTool[]> {
  const cached = toolCache.get(url);
  if (cached) return cached;
  const init = await mcpRpc(
    url,
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "openbb-desk", version: "0.1.0" },
    },
    1,
    null,
    fetchImpl
  );
  await mcpRpc(url, "notifications/initialized", undefined, null, init.sessionId, fetchImpl);
  const list = await mcpRpc(url, "tools/list", undefined, 2, init.sessionId, fetchImpl);
  const result = (list.result ?? {}) as Record<string, unknown>;
  const rawTools = Array.isArray(result.tools) ? result.tools : [];
  const mapped: AgentTool[] = rawTools
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((t) => ({
      server_id: serverId,
      name: String(t.name ?? ""),
      url,
      endpoint: "",
      description: String(t.description ?? ""),
      input_schema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  toolCache.set(url, mapped);
  return mapped;
}

export async function assembleTools(
  mcpServers: McpServerConfig[],
  dashboardMcp: { widgetId: string; url: string }[],
  fetchImpl: typeof fetch = tauriFetch
): Promise<AgentTool[] | null> {
  const targets = new Map<string, string>(); // url -> server_id
  for (const s of mcpServers) if (s.enabled) targets.set(s.url, s.id);
  for (const d of dashboardMcp) {
    if (!targets.has(d.url)) targets.set(d.url, d.widgetId);
  }
  const out: AgentTool[] = [];
  for (const [url, serverId] of targets) {
    try {
      out.push(...(await discoverMcpTools(serverId, url, fetchImpl)));
    } catch (e) {
      // failures log + skip that server — never block chat
      logError(`MCP discovery failed for ${url}: ${String(e)}`);
    }
  }
  return out.length > 0 ? out : null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/agent/mcp.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd $REPO_ROOT
git add src/lib/agent/mcp.ts src/lib/agent/mcp.test.ts
git commit -m "feat: MCP streamable-http discovery client with session handling and tool assembly rule"
```

---

### Task 16: Chat pane UI — streaming, reasoning steps, artifacts, suggestions, offline states

**Files:**
- Create: `$REPO_ROOT/src/components/chat/ChatPane.tsx`
- Create: `$REPO_ROOT/src/components/chat/ChatMessages.tsx`
- Create: `$REPO_ROOT/src/components/chat/ArtifactView.tsx`
- Test: `$REPO_ROOT/src/components/chat/ChatPane.test.tsx`
- Modify: `$REPO_ROOT/src/components/AppShell.tsx` (replace Rita pane placeholder; wire `onActivityChange={setChatSticky}` and remove the `void setChatSticky;` line)
- Modify: `$REPO_ROOT/src/styles.css` (append chat styles)

**Interfaces:**
- Consumes: `fetchAgents`, `runAgentQuery`, `buildWidgetRefs`, `makeWidgetDataFetcher` (Task 14); `assembleTools` (Task 15); agent types (Task 13); all stores (Task 5); `TableRenderer` (Task 10); `ChartRenderer`, `PlotlyFigure` (Task 11); `logError` (Task 4).
- Produces:
  - `ChatPane` props: `{ onActivityChange(active: boolean): void }` — active while input focused OR a turn is streaming/awaiting a function result (drives the pane's stickiness).
  - `ChatMessages` props: `{ items: TranscriptItem[] }` where `type TranscriptItem = { kind: "user"; text: string } | { kind: "assistant"; text: string } | { kind: "status"; status: StatusUpdate } | { kind: "artifact"; artifact: ClientArtifact }` (exported from `ChatPane.tsx`).
  - `ArtifactView` props: `{ artifact: ClientArtifact }`.
  - Chat history persists in `localStorage` key `openbb-desk.chat` (protocol messages only; per-turn statuses/artifacts are session-scoped).
  - Turn state machine: `"idle" | "streaming" | "awaiting_function_result" | "done" | "error" | "offline"`.

- [ ] **Step 1: Write the failing test** — `src/components/chat/ChatPane.test.tsx`

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../lib/agent/types";

const fetchAgents = vi.fn();
const runAgentQuery = vi.fn();
vi.mock("../../lib/agent/agentClient", () => ({
  fetchAgents: (...a: unknown[]) => fetchAgents(...a),
  runAgentQuery: (...a: unknown[]) => runAgentQuery(...a),
  buildWidgetRefs: () => [],
  makeWidgetDataFetcher: () => async () => "[]",
}));
vi.mock("../../lib/agent/mcp", () => ({
  assembleTools: vi.fn(async () => null),
}));
vi.mock("../../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

import ChatPane from "./ChatPane";
import { useSettingsStore } from "../../stores/settingsStore";
import { DEFAULT_SETTINGS } from "../../lib/persistence";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSettingsStore.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
});

describe("ChatPane", () => {
  it("shows Rita offline with url and reason when agents.json fails", async () => {
    fetchAgents.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    render(<ChatPane onActivityChange={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Rita offline: http:\/\/agent-host:8002 \(.*ECONNREFUSED.*\)/)
      ).toBeInTheDocument()
    );
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });

  it("streams a reply and renders suggestions", async () => {
    fetchAgents.mockResolvedValue({
      openbb_agent_rita: {
        name: "Rita", description: "", endpoints: { query: "/v1/query" },
        features: { streaming: true },
      },
    });
    runAgentQuery.mockImplementation(
      async (opts: { onEvent: (e: AgentEvent) => void }) => {
        opts.onEvent({ kind: "status", status: { eventType: "INFO", message: "Reasoning", group: "r" } });
        opts.onEvent({ kind: "chunk", delta: "Hello from Rita" });
        opts.onEvent({ kind: "suggestions", suggestions: ["Chart it"] });
        return [
          { role: "human", content: "hi" },
          { role: "ai", content: "Hello from Rita" },
        ];
      }
    );
    render(<ChatPane onActivityChange={() => {}} />);
    await waitFor(() => expect(screen.getByPlaceholderText(/Ask Rita/)).toBeEnabled());
    fireEvent.change(screen.getByPlaceholderText(/Ask Rita/), { target: { value: "hi" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Hello from Rita")).toBeInTheDocument());
    expect(screen.getByText("Reasoning")).toBeInTheDocument();
    expect(screen.getByText("Chart it")).toBeInTheDocument();
    // history persisted
    expect(JSON.parse(localStorage.getItem("openbb-desk.chat")!)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/chat/ChatPane.test.tsx`
Expected: FAIL — `Cannot find module './ChatPane'`.

- [ ] **Step 3: Implement `src/components/chat/ArtifactView.tsx`**

```tsx
import type { ClientArtifact } from "../../lib/agent/types";
import type { PlotlyFigure } from "../../lib/chartShapes";
import ChartRenderer from "../renderers/ChartRenderer";
import TableRenderer from "../renderers/TableRenderer";

function figureFromArtifact(a: ClientArtifact): PlotlyFigure | null {
  if (!Array.isArray(a.content)) return null;
  const p = a.chart_params ?? {};
  const records = a.content;
  const type = String(p.chartType ?? "line");
  if (type === "pie" || type === "donut") {
    const angleKey = String(p.angleKey ?? "");
    const labelKey = String(p.calloutLabelKey ?? "");
    if (!angleKey || !labelKey) return null;
    return {
      data: [{
        type: "pie",
        values: records.map((r) => r[angleKey]),
        labels: records.map((r) => r[labelKey]),
        hole: type === "donut" ? 0.4 : 0,
      }],
      layout: {},
    };
  }
  const xKey = String(p.xKey ?? "");
  const yKey = String(p.yKey ?? "");
  if (!xKey || !yKey) return null;
  const xy = { x: records.map((r) => r[xKey]), y: records.map((r) => r[yKey]) };
  return type === "bar"
    ? { data: [{ type: "bar", ...xy }], layout: {} }
    : { data: [{ type: "scatter", mode: "lines", ...xy }], layout: {} };
}

export default function ArtifactView({ artifact }: { artifact: ClientArtifact }) {
  return (
    <div className="chat-artifact">
      <div className="chat-artifact-name" title={artifact.description}>
        {artifact.name}
      </div>
      {artifact.type === "table" && Array.isArray(artifact.content) ? (
        <div className="chat-artifact-table">
          <TableRenderer records={artifact.content} columnsDefs={null} />
        </div>
      ) : artifact.type === "chart" ? (
        (() => {
          const fig = figureFromArtifact(artifact);
          return fig ? (
            <div className="chat-artifact-chart"><ChartRenderer figure={fig} /></div>
          ) : (
            <pre className="raw-json">{JSON.stringify(artifact.content, null, 2)}</pre>
          );
        })()
      ) : artifact.type === "html" ? (
        <iframe
          className="widget-frame chat-artifact-frame"
          title={`artifact-${artifact.uuid}`}
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={String(artifact.content)}
        />
      ) : (
        <pre className="raw-json">
          {typeof artifact.content === "string"
            ? artifact.content
            : JSON.stringify(artifact.content, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/components/chat/ChatMessages.tsx`**

```tsx
import ReactMarkdown from "react-markdown";
import { useEffect, useRef } from "react";
import type { TranscriptItem } from "./ChatPane";
import ArtifactView from "./ArtifactView";

export default function ChatMessages({ items }: { items: TranscriptItem[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  return (
    <div className="chat-messages">
      {items.map((item, i) => {
        switch (item.kind) {
          case "user":
            return <div key={i} className="chat-user">{item.text}</div>;
          case "assistant":
            return (
              <div key={i} className="chat-assistant">
                <ReactMarkdown>{item.text}</ReactMarkdown>
              </div>
            );
          case "status":
            return item.status.hidden ? null : (
              <div key={i} className={`chat-status chat-status-${item.status.eventType.toLowerCase()}`}>
                {item.status.group ? `[${item.status.group}] ` : ""}
                {item.status.message}
              </div>
            );
          case "artifact":
            return <ArtifactView key={i} artifact={item.artifact} />;
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 5: Implement `src/components/chat/ChatPane.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildWidgetRefs, fetchAgents, makeWidgetDataFetcher, runAgentQuery,
} from "../../lib/agent/agentClient";
import { assembleTools } from "../../lib/agent/mcp";
import type {
  AgentFeatureOption, AgentInfo, ChatMessage, ClientArtifact, StatusUpdate,
} from "../../lib/agent/types";
import { logError } from "../../lib/logger";
import { useBackendsStore } from "../../stores/backendsStore";
import { useDashboardStore } from "../../stores/dashboardStore";
import { useRegistryStore } from "../../stores/registryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import ChatMessages from "./ChatMessages";

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "status"; status: StatusUpdate }
  | { kind: "artifact"; artifact: ClientArtifact };

type TurnStatus =
  | "idle" | "streaming" | "awaiting_function_result"
  | "done" | "error" | "offline";

const CHAT_KEY = "openbb-desk.chat";

function loadHistory(): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]") as ChatMessage[];
  } catch {
    return [];
  }
}

function transcriptFromHistory(messages: ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const m of messages) {
    if (m.role === "human") items.push({ kind: "user", text: m.content });
    else if (m.role === "ai" && typeof m.content === "string") {
      items.push({ kind: "assistant", text: m.content });
    }
  }
  return items;
}

export default function ChatPane({
  onActivityChange,
}: {
  onActivityChange(active: boolean): void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const ritaUrl = settings?.ritaUrl ?? "";
  const [agent, setAgent] = useState<{ id: string; info: AgentInfo } | null>(null);
  const [offlineReason, setOfflineReason] = useState<string | null>(null);
  const [status, setStatus] = useState<TurnStatus>("idle");
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(loadHistory);
  const [items, setItems] = useState<TranscriptItem[]>(() =>
    transcriptFromHistory(loadHistory())
  );
  const abortRef = useRef<AbortController | null>(null);
  const [focused, setFocused] = useState(false);

  const busy = status === "streaming" || status === "awaiting_function_result";
  useEffect(() => onActivityChange(busy || focused), [busy, focused, onActivityChange]);

  const connect = useCallback(async () => {
    if (!ritaUrl) return;
    try {
      const agents = await fetchAgents(ritaUrl);
      const id = agents.openbb_agent_rita ? "openbb_agent_rita" : Object.keys(agents)[0];
      if (!id) throw new Error("agents.json is empty");
      setAgent({ id, info: agents[id] });
      const feat = agents[id].features.model;
      setModel(typeof feat === "object" ? feat.default : null);
      setOfflineReason(null);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`Rita discovery failed: ${ritaUrl}: ${reason}`);
      setAgent(null);
      setOfflineReason(reason);
      setStatus("offline");
    }
  }, [ritaUrl]);

  useEffect(() => { void connect(); }, [connect]);

  const send = useCallback(
    async (text: string) => {
      if (!agent || text.trim() === "" || busy) return;
      const queryUrl = new URL(agent.info.endpoints.query, ritaUrl).toString();
      setSuggestions([]);
      setStatus("streaming");
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const base: ChatMessage[] = [...messages, { role: "human", content: text }];
      setItems((it) => [...it, { kind: "user", text }, { kind: "assistant", text: "" }]);
      const contextSharing = settings?.contextSharing ?? true;
      const cards = useDashboardStore.getState().active()?.cards ?? [];
      const lookupWidget = useRegistryStore.getState().find;
      const getBackend = (id: string) =>
        useBackendsStore.getState().backends.find((b) => b.id === id);
      const widgets = contextSharing
        ? buildWidgetRefs(cards, lookupWidget, (id) => getBackend(id)?.name ?? id)
        : [];
      const dashboardMcp = cards.flatMap((c) => {
        const w = lookupWidget(c.backendId, c.widgetId);
        return w?.mcpUrl ? [{ widgetId: w.id, url: w.mcpUrl }] : [];
      });
      try {
        const tools = await assembleTools(settings?.mcpServers ?? [], dashboardMcp);
        const final = await runAgentQuery({
          queryUrl,
          messages: base,
          widgets,
          tools,
          workspaceOptions: model ? { model } : {},
          signal: ctrl.signal,
          onEvent: (ev) => {
            // side effects OUTSIDE the state updater (StrictMode double-invokes updaters)
            if (ev.kind === "suggestions") {
              setSuggestions(ev.suggestions);
              return;
            }
            if (ev.kind === "functionCall") setStatus("awaiting_function_result");
            if (ev.kind === "chunk") setStatus("streaming");
            setItems((it) => {
              const next = [...it];
              const last = next[next.length - 1];
              switch (ev.kind) {
                case "chunk":
                  if (last?.kind === "assistant") {
                    next[next.length - 1] = { kind: "assistant", text: last.text + ev.delta };
                  }
                  return next;
                case "status":
                  next.splice(next.length - 1, 0, { kind: "status", status: ev.status });
                  return next;
                case "artifact":
                  next.splice(next.length - 1, 0, { kind: "artifact", artifact: ev.artifact });
                  return next;
                case "functionCall":
                  next.splice(next.length - 1, 0, {
                    kind: "status",
                    status: { eventType: "INFO", message: `Running ${ev.call.function}…`, group: "tools" },
                  });
                  return next;
                case "citations":
                  next.splice(next.length - 1, 0, {
                    kind: "status",
                    status: { eventType: "INFO", message: `${ev.citations.length} citation(s)`, group: "citations" },
                  });
                  return next;
                default:
                  return next;
              }
            });
          },
          fetchWidgetData: makeWidgetDataFetcher({
            getCards: () => useDashboardStore.getState().active()?.cards ?? [],
            lookupWidget,
            getBackend,
          }),
        });
        setMessages(final);
        localStorage.setItem(CHAT_KEY, JSON.stringify(final));
        setStatus("done");
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (ctrl.signal.aborted) {
          setItems((it) => [...it, {
            kind: "status",
            status: { eventType: "WARNING", message: "Stopped.", group: "chat" },
          }]);
          setStatus("done");
        } else {
          logError(`Rita query failed: ${queryUrl}: ${reason}`);
          setItems((it) => [...it, {
            kind: "status",
            status: {
              eventType: "ERROR",
              // network failure vs HTTP error body: fetch TypeError has no "HTTP"
              message: reason.includes("HTTP")
                ? `Rita error: ${reason}`
                : `Rita offline: ${ritaUrl} (${reason})`,
              group: "chat",
            },
          }]);
          setStatus("error");
        }
      } finally {
        abortRef.current = null;
      }
    },
    [agent, busy, messages, model, ritaUrl, settings]
  );

  if (offlineReason !== null) {
    return (
      <div className="chat-offline">
        <p>Rita offline: {ritaUrl} ({offlineReason})</p>
        <button onClick={() => void connect()}>Retry</button>
      </div>
    );
  }

  const modelFeature =
    agent && typeof agent.info.features.model === "object"
      ? (agent.info.features.model as AgentFeatureOption)
      : null;

  return (
    <div className="chat-pane">
      <div className="chat-toolbar">
        {modelFeature && (
          <label>
            {modelFeature.label}{" "}
            <select value={model ?? ""} onChange={(e) => setModel(e.target.value)}>
              {modelFeature.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        )}
        <span className="chat-context-note" title="Toggle in Settings">
          {settings?.contextSharing ? "context: on" : "context: off"}
        </span>
        <button
          onClick={() => {
            setMessages([]); setItems([]); setSuggestions([]);
            localStorage.removeItem(CHAT_KEY);
          }}
        >
          Clear
        </button>
      </div>
      <ChatMessages items={items} />
      {suggestions.length > 0 && (
        <div className="chat-suggestions">
          {suggestions.map((s) => (
            <button key={s} onClick={() => void send(s)}>{s}</button>
          ))}
        </div>
      )}
      <div className="chat-input-row">
        <textarea
          placeholder="Ask Rita about your dashboard…"
          value={input}
          disabled={!agent}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              const text = input;
              setInput("");
              void send(text);
            }
          }}
        />
        {busy ? (
          <button onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button
            disabled={!agent || input.trim() === ""}
            onClick={() => {
              const text = input;
              setInput("");
              void send(text);
            }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run src/components/chat/ChatPane.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Wire into `AppShell.tsx` and add styles**

In `src/components/AppShell.tsx`: add `import ChatPane from "./chat/ChatPane";`, delete the `void setChatSticky;` line, and replace the RitaPane children placeholder:

```tsx
      <RitaPane
        pinned={pinned}
        sticky={chatSticky}
        onTogglePin={() => setPinned((p) => !p)}
      >
        <ChatPane onActivityChange={setChatSticky} />
      </RitaPane>
```

Append to `src/styles.css`:

```css
/* ---- chat pane ---- */
.chat-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.chat-toolbar {
  display: flex; gap: 8px; align-items: center;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  font-size: 11px; color: var(--text-dim);
}
.chat-messages { flex: 1; overflow: auto; padding: 8px 10px; }
.chat-user {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 10px; margin: 6px 0 6px 40px;
}
.chat-assistant { margin: 6px 0; }
.chat-assistant p { margin: 4px 0; }
.chat-status { color: var(--text-dim); font-size: 11px; margin: 2px 0; }
.chat-status-error { color: var(--error); }
.chat-status-warning { color: #d9b45f; }
.chat-artifact {
  border: 1px solid var(--border); border-radius: 6px;
  margin: 6px 0; overflow: hidden;
}
.chat-artifact-name {
  padding: 4px 8px; background: var(--bg-panel);
  border-bottom: 1px solid var(--border); font-weight: 600;
}
.chat-artifact-table { max-height: 220px; overflow: auto; }
.chat-artifact-chart { height: 220px; }
.chat-artifact-frame { height: 220px; }
.chat-suggestions {
  display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 10px;
  border-top: 1px solid var(--border);
}
.chat-input-row {
  display: flex; gap: 6px; padding: 8px 10px;
  border-top: 1px solid var(--border);
}
.chat-input-row textarea { flex: 1; resize: none; height: 56px; }
.chat-offline { padding: 12px; color: var(--error); }
```

- [ ] **Step 8: Verify manually against Rita on the Spark** (requires the Spark/NAS AI-stack plan deployed; if Rita is not up yet, verify the offline path only and return to this step later)

Run: `pnpm tauri dev`
1. With Rita stopped/unreachable: pane shows `Rita offline: http://agent-host:8002 (<reason>)` with Retry. Dashboards unaffected.
2. With Rita up: type a question, Enter — reply streams token-by-token; reasoning/status lines render dim above the reply; suggestions appear as clickable chips; Stop aborts mid-stream.
3. Pane stays open while the input is focused and while streaming, even when the mouse leaves; collapses ~300ms after both end.
4. With the Historical card on the dashboard, ask "What is on my dashboard?" — Rita names the widget (context sharing). Ask a data question — a `Running get_widget_data…` status appears (function-call round trip) and the answer uses live values. Toggle context sharing off in Settings (Task 17) and confirm widgets are no longer mentioned.
5. Restart the app: the conversation text is still there (localStorage).

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: Rita chat pane with SSE streaming, status steps, artifacts, suggestions, offline states"
```

---
### Task 17: Backends and Settings dialogs, error-surface polish

**Files:**
- Create: `$REPO_ROOT/src/components/Modal.tsx`
- Create: `$REPO_ROOT/src/components/dialogs/BackendsDialog.tsx`
- Create: `$REPO_ROOT/src/components/dialogs/SettingsDialog.tsx`
- Test: `$REPO_ROOT/src/components/dialogs/dialogs.test.tsx`
- Modify: `$REPO_ROOT/src/components/AppShell.tsx` (replace the two modal placeholders)
- Modify: `$REPO_ROOT/src/styles.css` (append modal styles)

**Interfaces:**
- Consumes: `useBackendsStore`, `useRegistryStore`, `useSettingsStore` (Task 5); `readLogTail`, `getLogPath`, `LOG_FILE` (Task 4); `clearMcpCache` (Task 15).
- Produces:
  - `Modal` props: `{ title: string; onClose(): void; children: React.ReactNode }`
  - `BackendsDialog` props: `{ onClose(): void }` — per-backend online/offline dot (from `useBackendsStore.status`), "Refresh" (re-runs widget discovery, which re-tests reachability), add/remove backend (id from `crypto.randomUUID()`, optional auth header pair), plus the reminder that new non-tailnet hosts need a `src-tauri/capabilities/default.json` http-scope entry.
  - `SettingsDialog` props: `{ onClose(): void }` — Rita URL, context-sharing toggle, MCP server list (add/remove/enable; mutations call `clearMcpCache()`), log path + last 100 log lines.

- [ ] **Step 1: Write the failing test** — `src/components/dialogs/dialogs.test.tsx`

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/persistence", () => ({
  loadSettings: vi.fn(), saveSettings: vi.fn(async () => {}),
  loadBackends: vi.fn(), saveBackends: vi.fn(async () => {}),
  loadDashboards: vi.fn(), saveDashboard: vi.fn(async () => {}),
  deleteDashboard: vi.fn(async () => {}),
  DEFAULT_SETTINGS: {
    ritaUrl: "http://agent-host:8002", theme: "dark",
    contextSharing: true, mcpServers: [],
  },
  DEFAULT_BACKENDS: [],
}));
vi.mock("../../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
  LOG_FILE: "logs/openbb-desk.log",
  readLogTail: vi.fn(async () => ["2026-07-30T12:00:00Z [ERROR] sample line"]),
  getLogPath: vi.fn(async () =>
    "/Users/<owner>/Library/Application Support/com.<owner>.openbb-desk/logs/openbb-desk.log"),
}));
vi.mock("../../lib/agent/mcp", () => ({ clearMcpCache: vi.fn() }));

import BackendsDialog from "./BackendsDialog";
import SettingsDialog from "./SettingsDialog";
import { useBackendsStore } from "../../stores/backendsStore";
import { useSettingsStore } from "../../stores/settingsStore";

beforeEach(() => {
  useBackendsStore.setState({
    backends: [{ id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.ts.net" }],
    status: { nas: "offline" },
  });
  useSettingsStore.setState({
    settings: {
      ritaUrl: "http://agent-host:8002", theme: "dark",
      contextSharing: true,
      mcpServers: [{ id: "openbb-mcp", url: "https://openbb.example.ts.net:8443/mcp/", enabled: true }],
    },
  });
});

describe("BackendsDialog", () => {
  it("shows each backend with its online/offline status", () => {
    render(<BackendsDialog onClose={() => {}} />);
    expect(screen.getByText("OpenBB NAS")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText("https://openbb.example.ts.net")).toBeInTheDocument();
  });
});

describe("SettingsDialog", () => {
  it("shows the log path and tail, and toggles context sharing", async () => {
    render(<SettingsDialog onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/sample line/)).toBeInTheDocument()
    );
    expect(
      screen.getByText(/com\.<owner>\.openbb-desk\/logs\/openbb-desk\.log/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Share dashboard context/));
    expect(useSettingsStore.getState().settings!.contextSharing).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/dialogs/dialogs.test.tsx`
Expected: FAIL — cannot find the dialog modules.

- [ ] **Step 3: Implement `src/components/Modal.tsx`**

```tsx
import type { ReactNode } from "react";

export default function Modal({
  title, onClose, children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{title}</strong>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement `src/components/dialogs/BackendsDialog.tsx`**

```tsx
import { useState } from "react";
import Modal from "../Modal";
import { useBackendsStore } from "../../stores/backendsStore";
import { useRegistryStore } from "../../stores/registryStore";

export default function BackendsDialog({ onClose }: { onClose(): void }) {
  const backends = useBackendsStore((s) => s.backends);
  const status = useBackendsStore((s) => s.status);
  const save = useBackendsStore((s) => s.save);
  const refresh = useRegistryStore((s) => s.refresh);
  const loading = useRegistryStore((s) => s.loading);
  const [form, setForm] = useState({
    name: "", baseUrl: "", headerName: "", headerValue: "",
  });

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title="Backends" onClose={onClose}>
      <ul className="backend-list">
        {backends.map((b) => (
          <li key={b.id}>
            <span className={`status-dot ${status[b.id] ?? "unknown"}`} />
            <strong>{b.name}</strong>
            <span className="backend-url">{b.baseUrl}</span>
            <span>{status[b.id] ?? "unknown"}</span>
            {backends.length > 1 && (
              <button
                onClick={() => void save(backends.filter((x) => x.id !== b.id))}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <button disabled={loading} onClick={() => void refresh(backends)}>
        {loading ? "Refreshing…" : "Refresh widgets / test connections"}
      </button>
      <h4>Add backend</h4>
      <div className="form-grid">
        <input placeholder="Name" value={form.name} onChange={set("name")} />
        <input placeholder="Base URL (https://host)" value={form.baseUrl} onChange={set("baseUrl")} />
        <input placeholder="Auth header name (optional)" value={form.headerName} onChange={set("headerName")} />
        <input placeholder="Auth header value (optional)" value={form.headerValue} onChange={set("headerValue")} />
        <button
          disabled={form.name.trim() === "" || form.baseUrl.trim() === ""}
          onClick={() => {
            const next = [...backends, {
              id: crypto.randomUUID(),
              name: form.name.trim(),
              baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
              ...(form.headerName.trim()
                ? { headerName: form.headerName.trim(), headerValue: form.headerValue }
                : {}),
            }];
            void save(next).then(() => refresh(next));
            setForm({ name: "", baseUrl: "", headerName: "", headerValue: "" });
          }}
        >
          Add
        </button>
      </div>
      <p className="dialog-note">
        Hosts outside the tailnet also need an entry in
        src-tauri/capabilities/default.json (http scope) and an app rebuild.
      </p>
    </Modal>
  );
}
```

- [ ] **Step 5: Implement `src/components/dialogs/SettingsDialog.tsx`**

```tsx
import { useEffect, useState } from "react";
import Modal from "../Modal";
import { clearMcpCache } from "../../lib/agent/mcp";
import { getLogPath, readLogTail } from "../../lib/logger";
import { useSettingsStore } from "../../stores/settingsStore";

export default function SettingsDialog({ onClose }: { onClose(): void }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const [logPath, setLogPath] = useState("");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [newMcpUrl, setNewMcpUrl] = useState("");

  const loadLog = async () => {
    try {
      setLogPath(await getLogPath());
    } catch {
      setLogPath("(available in the packaged app)");
    }
    setLogLines(await readLogTail(100));
  };
  useEffect(() => { void loadLog(); }, []);

  if (!settings) return null;

  return (
    <Modal title="Settings" onClose={onClose}>
      <h4>Rita</h4>
      <label className="settings-row">
        Agent URL{" "}
        <input
          value={settings.ritaUrl}
          onChange={(e) => void update({ ritaUrl: e.target.value })}
          style={{ width: 260 }}
        />
      </label>
      <label className="settings-row">
        <input
          type="checkbox"
          checked={settings.contextSharing}
          onChange={(e) => void update({ contextSharing: e.target.checked })}
        />{" "}
        Share dashboard context with Rita
      </label>
      <h4>MCP servers</h4>
      <ul className="mcp-list">
        {settings.mcpServers.map((m) => (
          <li key={m.id}>
            <input
              type="checkbox"
              checked={m.enabled}
              onChange={(e) => {
                clearMcpCache();
                void update({
                  mcpServers: settings.mcpServers.map((x) =>
                    x.id === m.id ? { ...x, enabled: e.target.checked } : x
                  ),
                });
              }}
            />
            <span className="backend-url">{m.url}</span>
            <button
              onClick={() => {
                clearMcpCache();
                void update({
                  mcpServers: settings.mcpServers.filter((x) => x.id !== m.id),
                });
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="form-grid">
        <input
          placeholder="https://host/mcp/"
          value={newMcpUrl}
          onChange={(e) => setNewMcpUrl(e.target.value)}
        />
        <button
          disabled={newMcpUrl.trim() === ""}
          onClick={() => {
            clearMcpCache();
            void update({
              mcpServers: [
                ...settings.mcpServers,
                { id: crypto.randomUUID(), url: newMcpUrl.trim(), enabled: true },
              ],
            });
            setNewMcpUrl("");
          }}
        >
          Add
        </button>
      </div>
      <h4>Log</h4>
      <p className="dialog-note">{logPath}</p>
      <pre className="raw-json log-view">
        {logLines.length > 0 ? logLines.join("\n") : "(log is empty)"}
      </pre>
      <button onClick={() => void loadLog()}>Reload log</button>
    </Modal>
  );
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run src/components/dialogs/dialogs.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Wire into `AppShell.tsx` and add styles**

In `src/components/AppShell.tsx`, add imports and replace the two modal placeholders:

```tsx
import BackendsDialog from "./dialogs/BackendsDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
```

```tsx
      {backendsOpen && <BackendsDialog onClose={() => setBackendsOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
```

Append to `src/styles.css`:

```css
/* ---- modals ---- */
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 8px; width: 560px; max-height: 80vh;
  display: flex; flex-direction: column;
}
.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px; border-bottom: 1px solid var(--border);
}
.modal-body { padding: 12px 14px; overflow: auto; }
.backend-list, .mcp-list { list-style: none; padding: 0; margin: 8px 0; }
.backend-list li, .mcp-list li {
  display: flex; gap: 8px; align-items: center; padding: 4px 0;
}
.backend-url { color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); }
.status-dot.online { background: #5fb87a; }
.status-dot.offline { background: var(--error); }
.form-grid { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.dialog-note { color: var(--text-dim); font-size: 11px; }
.settings-row { display: block; margin: 6px 0; }
.log-view { max-height: 180px; border: 1px solid var(--border); }
```

- [ ] **Step 8: Verify the three failure surfaces manually**

Run: `pnpm tauri dev`
1. **NAS unreachable:** disconnect Tailscale (or set the NAS backend URL to a dead host). Relaunch: the app still opens instantly, dashboards render the saved layout with inline error cards + Retry; Backends dialog shows the red offline dot. Reconnect, hit "Refresh widgets / test connections": dot goes green, cards recover on Retry/⟳.
2. **Rita unreachable:** stop Rita — pane shows `Rita offline: <url> (<reason>)`; dashboards keep working.
3. **Log:** Settings shows the absolute log path and the last 100 lines including the errors just produced. `logs/openbb-desk.log.1` appears once the log passes 1MB (can be forced with `yes "filler" | head -c 1100000 >> "$HOME/Library/Application Support/com.<owner>.openbb-desk/logs/openbb-desk.log"` then triggering any log write).

- [ ] **Step 9: Run the full suite and commit**

Run: `pnpm vitest run` — all green.

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: backends and settings dialogs with connection status, MCP config, log viewer"
```

---

### Task 18: Icon, macOS bundle, GitHub repo + Windows CI, README

**Files:**
- Create: `$REPO_ROOT/scripts/make-icon.mjs`
- Create: `$REPO_ROOT/.github/workflows/windows-build.yml`
- Create: `$REPO_ROOT/README.md`
- Modify: `$REPO_ROOT/package.json` (ensure `packageManager` field)
- Generated: `src-tauri/icons/*` (via `pnpm tauri icon`)

**Interfaces:**
- Consumes: the finished app (Tasks 1–17).
- Produces: unsigned macOS `.dmg` (Apple Silicon, built locally) and Windows NSIS `.exe` x64 (built by GitHub Actions on `workflow_dispatch`, uploaded as a workflow artifact); private repo `<owner>/openbb-desk`.

- [ ] **Step 1: Write `scripts/make-icon.mjs`** (zero-dep 1024x1024 solid-color PNG — placeholder until the user picks a real icon)

```js
// Generates src-tauri/icon-src.png: 1024x1024 solid-color RGBA PNG, no deps.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 1024;
const H = 1024;
const RGBA = [0x1f, 0x6f, 0x4a, 0xff]; // placeholder green

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA

const row = Buffer.alloc(1 + W * 4); // leading 0 = filter "None"
for (let x = 0; x < W; x++) {
  for (let i = 0; i < 4; i++) row[1 + x * 4 + i] = RGBA[i];
}
const raw = Buffer.concat(Array.from({ length: H }, () => row));

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("src-tauri/icon-src.png", png);
console.log("wrote src-tauri/icon-src.png");
```

- [ ] **Step 2: Generate the icon set**

```bash
cd $REPO_ROOT
node scripts/make-icon.mjs
pnpm tauri icon src-tauri/icon-src.png
```

Expected: `src-tauri/icons/` now contains `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico`, and friends (the paths `tauri.conf.json` already references).

- [ ] **Step 3: Ensure the `packageManager` field** (pnpm/action-setup@v4 requires it)

In `package.json`, confirm a top-level `"packageManager": "pnpm@<version>"` entry exists; if missing, add one matching the local version (`pnpm --version`), e.g.:

```json
  "packageManager": "pnpm@10.13.1"
```

- [ ] **Step 4: Build and verify the macOS bundle**

```bash
cd $REPO_ROOT
pnpm tauri build
```

Expected outputs under `src-tauri/target/release/bundle/`: `macos/OpenBB Desk.app` and `dmg/OpenBB Desk_0.1.0_aarch64.dmg`.
Manually verify: open the .dmg, drag the app to /Applications, launch it — **first launch is unsigned**: right-click → Open → Open (one-time Gatekeeper override). The app must show live NAS widgets and reach Rita like the dev build.

- [ ] **Step 5: Write `.github/workflows/windows-build.yml`**

```yaml
name: windows-build

on:
  workflow_dispatch:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable

      - run: pnpm install

      # Artifact-only build: no tagName/releaseName, so no release is created.
      - uses: tauri-apps/tauri-action@v1
        with:
          uploadWorkflowArtifacts: true
```

- [ ] **Step 6: Write `README.md`**

```markdown
# OpenBB Desk

Custom Tauri 2 desktop frontend for a self-hosted OpenBB stack: widget
dashboards over the NAS OpenBB Platform API (widgets.json protocol) plus an
AI pane speaking the OpenBB custom-agent protocol to Agent Rita on the Spark.
All traffic stays on the tailnet; no OpenBB cloud anywhere.

## Run / develop

    pnpm install
    pnpm tauri dev     # run the app
    pnpm vitest run    # unit + integration tests (no live services needed)

## Build

- macOS (local): `pnpm tauri build` → `src-tauri/target/release/bundle/dmg/`.
  Unsigned: first launch needs right-click → Open.
- Windows: GitHub Actions → "windows-build" → Run workflow → download the
  artifact (NSIS .exe). Unsigned: SmartScreen → "More info" → "Run anyway".

## Configuration (created on first run)

`~/Library/Application Support/com.<owner>.openbb-desk/` (macOS) /
`%APPDATA%/com.<owner>.openbb-desk/` (Windows):

- `settings.json` — Rita URL (default http://agent-host:8002),
  context sharing, MCP server list (defaults: NAS :8443 and :8444 /mcp/).
- `backends.json` — OpenBB backends (default: https://openbb.example.ts.net).
- `dashboards/<uuid>.json` — one file per dashboard; plain JSON, back up freely.
- `logs/openbb-desk.log` — rotating app log (also viewable in Settings).

## Adding a backend outside the tailnet

The HTTP allowlist is intentionally minimal. Add the new origin to
`src-tauri/capabilities/default.json` under the `http:default` permission and
rebuild — the Backends dialog alone is not enough.

## Keyboard

- Cmd/Ctrl+Shift+A — pin/unpin the Rita pane (docked vs hover-overlay).
```

- [ ] **Step 7: Commit, create the private GitHub repo, push**

```bash
cd $REPO_ROOT
git add -A
git commit -m "feat: app icon, README, Windows CI workflow"
gh repo create <owner>/openbb-desk --private --source . --push
```

If the push fails with `tls: bad record MAC` (known flaky link on large pushes): retry `git push -u origin main` a few times; if it keeps failing, push commits in smaller chunks (`git push origin <earlier-sha>:refs/heads/main`, then `git push`) or fall back to uploading via the gh contents API.

- [ ] **Step 8: Run the Windows build and fetch the artifact**

```bash
gh workflow run windows-build.yml
gh run watch          # wait for success (~10-20 min)
gh run download --dir /tmp/openbb-desk-win   # grabs the NSIS .exe artifact
```

Expected: artifact contains `OpenBB Desk_0.1.0_x64-setup.exe`. On a Windows machine: SmartScreen shows "Windows protected your PC" → "More info" → "Run anyway" (unsigned, one-time). Verify install + launch + NAS widgets when a Windows box is available.

- [ ] **Step 9: Final check and commit**

Run: `pnpm vitest run` (all green) and `pnpm tauri build` (still builds).

```bash
git add -A
git commit -m "chore: v0.1.0 packaging complete" --allow-empty
git push
```

---

## Success criteria → task map (spec "Success criteria (v1 done)")

| # | Criterion | Tasks |
|---|-----------|-------|
| 1 | Mac `.dmg` and Windows `.exe` install and launch as normal apps | 1, 18 |
| 2 | Left rail: icon-width at rest, hover-expands, dashboards + widget library, backends/settings pinned bottom | 6, 7, 8, 17 |
| 3 | Right pane: folded at rest, hover-expands, pin + focus/streaming stickiness | 6, 16 |
| 4 | Widget library lists NAS-discovered widgets; add/arrange/resize/remove; dashboards persist across restarts | 2, 3, 4, 5, 7, 8 |
| 5 | Table and chart widgets render live NAS data, incl. OpenBB Plotly figures | 3, 9, 10, 11 |
| 5a | HTML widget renders server HTML with working JS; toggles to `raw=true` table view | 3, 10, 12 |
| 5b | iframe widget renders its URL; `storage.mcpUrl` feeds Rita's `QueryRequest.tools` while on the active dashboard | 2, 12, 15, 16 |
| 6 | Chat pane streams Rita answers with active-dashboard context; Rita can pull NAS/store data (get_widget_data + MCP tools) | 13, 14, 15, 16 |
| 7 | Failure surfaces degrade per the error-handling section (error cards + offline dot, "Rita offline", raw-JSON fallback, rotating log) | 4, 5, 10, 16, 17 |

## Appendix: manual E2E checklist (against live NAS + Rita)

Run once after Task 18, on the packaged macOS build:

1. Launch from /Applications (right-click → Open the first time). Window "OpenBB Desk", 1440x900.
2. Rail: hover expand/collapse (~300ms), dashboard list inline, library/backends/settings open from their icons; grid never reflows on rail hover.
3. Library: search "historical", add table + chart widgets; drag/resize/remove; add a second dashboard and switch between them; relaunch → everything persists.
4. Widgets: table sorts and formats; chart renders openbb-charting figure; table↔chart toggle on the OHLC table; IMF html widget is interactive and its Raw toggle works; pdf-type widget shows the unsupported card.
5. Rita smoke test first (per spec): from the Mac, `curl http://agent-host:8002/agents.json` returns the Rita entry, and `curl -N -X POST http://agent-host:8002/v1/query -H 'Content-Type: application/json' -d '{"messages":[{"role":"human","content":"ping"}]}'` streams SSE events — only then test in-app. Then: hover-expand pane, pin with Cmd+Shift+A (grid reflows), unpin; ask a question → streaming text + status steps; ask about on-screen data → `get_widget_data` round trip; suggestions clickable; Stop aborts; relaunch → history intact.
6. Failure drills: NAS off → error cards + offline dot, app still launches; Rita off → "Rita offline: url (reason)"; malformed endpoint (bad symbol) → raw JSON/error card, never blank; Settings shows the log tail with those errors.

## Deviations & plan-time decisions (recorded)

- **Dashboard-context size threshold** (spec open item): resolved as "no proactive data push" — the agent protocol's `get_widget_data` round trip supplies data on demand, so no threshold is needed.
- **CustomEvent bridge / iframe postMessage protocol**: deferred from v1 per spec; not planned here.
- **iframe sandbox sets** (spec open item): decided in Task 12 (html: `allow-scripts allow-forms allow-popups`; iframe: + `allow-same-origin`).
- **Rita deploy-config location** (spec open item): belongs to the separate Spark/NAS AI-stack plan, not this one.
- **Per-turn statuses/artifacts are not persisted** across app restarts — only protocol messages (localStorage). Matches "chat history lives in app local storage" with minimal machinery.
- **`refetchInterval`/`staleTime`**: parsed, ignored (v1 has no polling by spec).
- **Pinned columns** are ordered first/last rather than CSS-sticky — v1 simplification of `pinned`.
