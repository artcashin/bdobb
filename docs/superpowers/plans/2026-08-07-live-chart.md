# Live Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `live_chart` widget — a chart that seeds from `live-grid`'s kdb+ cache and then keeps drawing itself, bucketing the same tick stream that already drives the `live_grid` table.

**Architecture:** Two pure logic modules (bucketing math, Plotly figure builders) with zero React/DOM dependency, a thin Plotly-lifecycle wrapper component, and a renderer that owns its own per-symbol seeding and websocket subscription — `WidgetCard.tsx`'s generic single-endpoint seed fetch can't handle `/series`'s one-symbol-per-call shape, so the renderer bypasses it entirely (Task 6).

**Tech Stack:** React 19 + TypeScript (bdobb), plotly.js-dist-min, Vitest + Testing Library. Task 1 is Python/FastAPI (openbb-docker) but touches no Python code — a data-only `widgets.json` entry.

## Repos and worktrees

This plan spans two repos, each with its own worktree already set up and verified on a clean baseline:

| Repo | Worktree | Branch | Tasks |
|---|---|---|---|
| openbb-docker | `/Users/artcashin/Developer/openbb-docker-live-chart` | `feat/live-chart` | 1 |
| bdobb | `/Users/artcashin/Developer/bdobb-live-chart` | `feat/live-chart` | 2–6 |

All file paths below are relative to whichever worktree the task names.

## Global Constraints

- No changes to `live-grid`'s Python app, `kdb-store`, or `openbb-kdb` — `GET /series` and `live_grid_ws` are unchanged, shipped in `v10.0.0` already (design spec, "Out of scope").
- `live_chart` is additive: `kdb_cache_chart` and `live_grid` are untouched (design spec, "Goal").
- Bucket boundaries are computed from `Date.now()` at message receipt, never from a tick's `updated_at` field (design spec, "Decisions taken").
- Volume panel visibility is driven by whether the data has volume, not by chart type (design spec, "Decisions taken").
- Multi-symbol line/area overlays are normalized to % change from each symbol's first seed bar's open (design spec, "Decisions taken").
- Multi-symbol + candle renders small multiples — one mini chart per symbol — never a disabled control or a first-symbol-only chart (design spec, "Decisions taken").

Full rationale for each of these lives in `docs/superpowers/specs/2026-08-07-live-chart-design.md`.

---

### Task 1: `live_chart` widget declaration (openbb-docker)

**Worktree:** `/Users/artcashin/Developer/openbb-docker-live-chart`

**Files:**
- Modify: `live-grid/widgets.json`
- Test: `live-grid/tests/test_main.py`

**Interfaces:**
- Produces: a `live_chart` entry in `GET /widgets.json`'s JSON body — `type: "live_chart"`, `endpoint: "series"`, `wsEndpoint: "live_grid_ws"`, `params: [symbol, interval]`. Every later task's bdobb code assumes this exact shape.

- [ ] **Step 1: Write the failing test**

Add to `live-grid/tests/test_main.py`, directly after `test_widgets_json_declares_the_live_grid_contract`:

```python
def test_widgets_json_declares_the_live_chart_contract():
    body = make_client().get("/widgets.json").json()
    w = body["live_chart"]
    assert w["type"] == "live_chart"
    assert w["endpoint"] == "series"
    assert w["wsEndpoint"] == "live_grid_ws"
    param_names = [p["paramName"] for p in w["params"]]
    assert param_names == ["symbol", "interval"]
    interval = next(p for p in w["params"] if p["paramName"] == "interval")
    assert [o["value"] for o in interval["options"]] == [
        "1s", "1m", "5m", "15m", "30m", "1h", "1d",
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd live-grid && source .venv/bin/activate && pytest tests/test_main.py::test_widgets_json_declares_the_live_chart_contract -v`
Expected: FAIL with `KeyError: 'live_chart'`

- [ ] **Step 3: Add the widget entry**

In `live-grid/widgets.json`, add a `"live_chart"` key alongside the existing `"live_grid"` and `"kdb_cache_chart"` keys (insert after `"kdb_cache_chart"`'s closing `}`, before the file's final `}`):

```json
  ,
  "live_chart": {
    "name": "Live Chart",
    "description": "Live price chart seeded from the kdb+ cache, extended tick by tick over the live quote stream.",
    "category": "Live",
    "type": "live_chart",
    "endpoint": "series",
    "wsEndpoint": "live_grid_ws",
    "gridData": { "w": 40, "h": 16 },
    "params": [
      {
        "paramName": "symbol", "type": "text", "value": "AAPL", "label": "Symbols",
        "description": "Comma-separated: US equities, crypto (BTC-USD), forex (EURUSD)",
        "multiSelect": true
      },
      {
        "paramName": "interval", "type": "text", "value": "1m", "label": "Interval",
        "options": [
          { "label": "1 second", "value": "1s" },
          { "label": "1 minute", "value": "1m" },
          { "label": "5 min", "value": "5m" },
          { "label": "15 min", "value": "15m" },
          { "label": "30 min", "value": "30m" },
          { "label": "1 hour", "value": "1h" },
          { "label": "1 day", "value": "1d" }
        ]
      }
    ],
    "source": ["EODHD", "kdb+"]
  }
```

(Adjust the leading comma/brace placement to keep the file valid JSON given its exact current structure — the entry is a sibling of `"live_grid"` and `"kdb_cache_chart"`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd live-grid && source .venv/bin/activate && pytest tests/test_main.py::test_widgets_json_declares_the_live_chart_contract -v`
Expected: PASS

- [ ] **Step 5: Run the full live-grid suite to confirm no regression**

Run: `cd live-grid && source .venv/bin/activate && pytest -q`
Expected: all tests pass (98 baseline + 1 new = 99)

- [ ] **Step 6: Commit**

```bash
git add live-grid/widgets.json live-grid/tests/test_main.py
git commit -m "feat(live-grid): declare the live_chart widget

Data-only widgets.json entry for Ep. 10's live chart. No server code
changes -- GET /series and live_grid_ws already exist and are unchanged."
```

---

### Task 2: bucketing and normalization math (bdobb)

**Worktree:** `/Users/artcashin/Developer/bdobb-live-chart`

**Files:**
- Create: `src/lib/liveChartBucketing.ts`
- Test: `src/lib/liveChartBucketing.test.ts`

**Interfaces:**
- Produces: `Bar`, `SeedBar`, `Tick` types; `BUCKET_MS: Record<string, number>`; `bucketStartMs(tsMs: number, bucketMs: number): number`; `seedToBar(seed: SeedBar): Bar`; `applyTick(bars: Bar[], tick: Tick, bucketMs: number, nowMs: number): Bar[]`; `hasVolumeData(bars: Bar[]): boolean`; `normalizePercent(bars: Bar[]): { date: number; value: number }[]`. Tasks 3 and 5 import all of these by name.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/liveChartBucketing.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  applyTick, bucketStartMs, hasVolumeData, normalizePercent, seedToBar, BUCKET_MS,
  type Bar,
} from "./liveChartBucketing";

describe("bucketStartMs", () => {
  it("floors a timestamp to the bucket boundary", () => {
    expect(bucketStartMs(65_000, BUCKET_MS["1m"])).toBe(60_000);
    expect(bucketStartMs(119_999, BUCKET_MS["1m"])).toBe(60_000);
    expect(bucketStartMs(120_000, BUCKET_MS["1m"])).toBe(120_000);
  });
});

describe("seedToBar", () => {
  it("parses an ISO date string into an epoch-ms bar", () => {
    const bar = seedToBar({
      date: "2026-08-07T13:59:00", open: 1, high: 2, low: 0.5, close: 1.5, volume: 100,
    });
    expect(bar.date).toBe(new Date("2026-08-07T13:59:00").getTime());
    expect(bar).toMatchObject({ open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
  });

  it("treats a non-numeric volume as no volume data", () => {
    const bar = seedToBar({
      date: "2026-08-07T13:59:00", open: 1, high: 1, low: 1, close: 1, volume: null,
    });
    expect(bar.volume).toBeNull();
  });
});

describe("applyTick", () => {
  const bucketMs = BUCKET_MS["1m"];
  const seed: Bar[] = [{ date: 0, open: 100, high: 101, low: 99, close: 100, volume: 50 }];

  it("updates high/low/close/volume within the same bucket", () => {
    const t1 = applyTick(seed, { symbol: "AAPL", price: 102, last_size: 5 }, bucketMs, 30_000);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ high: 102, low: 99, close: 102, volume: 55 });

    const t2 = applyTick(t1, { symbol: "AAPL", price: 98, last_size: 3 }, bucketMs, 45_000);
    expect(t2[0]).toMatchObject({ high: 102, low: 98, close: 98, volume: 58 });
  });

  it("starts a new bar when the tick crosses a bucket boundary", () => {
    const next = applyTick(seed, { symbol: "AAPL", price: 103, last_size: 2 }, bucketMs, 65_000);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      date: 60_000, open: 103, high: 103, low: 103, close: 103, volume: 2,
    });
    expect(next[0]).toBe(seed[0]); // the prior bar is untouched
  });

  it("drops a tick older than the in-progress bucket", () => {
    const advanced = applyTick(seed, { symbol: "AAPL", price: 103 }, bucketMs, 65_000);
    const dropped = applyTick(advanced, { symbol: "AAPL", price: 999 }, bucketMs, 10_000);
    expect(dropped).toBe(advanced); // unchanged reference: a true no-op
  });

  it("ignores a tick with a missing or non-finite price", () => {
    expect(applyTick(seed, { symbol: "AAPL", price: undefined }, bucketMs, 30_000)).toBe(seed);
    expect(applyTick(seed, { symbol: "AAPL", price: NaN }, bucketMs, 30_000)).toBe(seed);
  });

  it("starts a bar with null volume for a tick with no last_size (forex)", () => {
    const next = applyTick([], { symbol: "EURUSD", price: 1.08 }, bucketMs, 0);
    expect(next[0].volume).toBeNull();
  });
});

describe("hasVolumeData", () => {
  it("is false when every bar has null volume", () => {
    expect(hasVolumeData([{ date: 0, open: 1, high: 1, low: 1, close: 1, volume: null }])).toBe(false);
  });
  it("is true when at least one bar has real volume", () => {
    expect(hasVolumeData([
      { date: 0, open: 1, high: 1, low: 1, close: 1, volume: null },
      { date: 1, open: 1, high: 1, low: 1, close: 1, volume: 10 },
    ])).toBe(true);
  });
});

describe("normalizePercent", () => {
  it("computes percent change from the first bar's open", () => {
    const bars: Bar[] = [
      { date: 0, open: 100, high: 100, low: 100, close: 100, volume: null },
      { date: 1, open: 105, high: 105, low: 105, close: 110, volume: null },
    ];
    expect(normalizePercent(bars)).toEqual([
      { date: 0, value: 0 },
      { date: 1, value: 10 },
    ]);
  });

  it("does not divide by zero when the first bar's open is 0", () => {
    const bars: Bar[] = [{ date: 0, open: 0, high: 0, low: 0, close: 5, volume: null }];
    expect(normalizePercent(bars)).toEqual([{ date: 0, value: 0 }]);
  });

  it("returns an empty array for an empty series", () => {
    expect(normalizePercent([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run src/lib/liveChartBucketing.test.ts`
Expected: FAIL — `Cannot find module './liveChartBucketing'`

- [ ] **Step 3: Implement**

Create `src/lib/liveChartBucketing.ts`:

```typescript
export interface Bar {
  /** Bucket start, epoch ms. */
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** null means this symbol's ticks carry no volume data at all (forex). */
  volume: number | null;
}

export interface SeedBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface Tick {
  symbol: string;
  price?: unknown;
  last_size?: unknown;
}

export const BUCKET_MS: Record<string, number> = {
  "1s": 1_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

export function bucketStartMs(tsMs: number, bucketMs: number): number {
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

function toFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function seedToBar(seed: SeedBar): Bar {
  return {
    date: new Date(seed.date).getTime(),
    open: seed.open,
    high: seed.high,
    low: seed.low,
    close: seed.close,
    volume: typeof seed.volume === "number" ? seed.volume : null,
  };
}

/**
 * Folds one live tick into a bar series. Returns a new array -- same length
 * with the last bar updated in place when the tick lands in the current
 * bucket, one longer when it starts a new bucket, or `bars` itself
 * (unchanged reference) when the tick is unusable or older than the current
 * bucket. The unchanged-reference case lets a caller skip a re-render for a
 * true no-op tick.
 */
export function applyTick(bars: Bar[], tick: Tick, bucketMs: number, nowMs: number): Bar[] {
  const price = toFiniteNumber(tick.price);
  if (price === null) return bars;

  const start = bucketStartMs(nowMs, bucketMs);
  const last = bars[bars.length - 1];
  const lastSize = toFiniteNumber(tick.last_size);

  if (last && start < last.date) return bars; // out-of-order / clock skew

  if (last && start === last.date) {
    const updated: Bar = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: lastSize !== null ? (last.volume ?? 0) + lastSize : last.volume,
    };
    return [...bars.slice(0, -1), updated];
  }

  const fresh: Bar = {
    date: start,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: lastSize !== null ? lastSize : null,
  };
  return [...bars, fresh];
}

/** Whether any bar in the series carries real volume data -- false for a
 * forex symbol, whose ticks are bid/ask quotes with no last_size. */
export function hasVolumeData(bars: Bar[]): boolean {
  return bars.some((b) => b.volume !== null);
}

/** Percent change from the series' first bar's open -- the shared basis a
 * multi-symbol overlay normalizes every symbol against, so a $150 and a
 * $60,000 symbol share one readable axis. */
export function normalizePercent(bars: Bar[]): { date: number; value: number }[] {
  if (bars.length === 0) return [];
  const base = bars[0].open;
  if (base === 0) return bars.map((b) => ({ date: b.date, value: 0 }));
  return bars.map((b) => ({ date: b.date, value: ((b.close - base) / base) * 100 }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run src/lib/liveChartBucketing.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/liveChartBucketing.ts src/lib/liveChartBucketing.test.ts
git commit -m "feat(live-chart): client-side tick bucketing and normalization

Pure functions -- no React, no DOM. applyTick folds one live_grid_ws
tick into a bar series; normalizePercent is the basis for the
multi-symbol overlay."
```

---

### Task 3: Plotly figure builders (bdobb)

**Worktree:** `/Users/artcashin/Developer/bdobb-live-chart`

**Files:**
- Create: `src/lib/liveChartFigure.ts`
- Test: `src/lib/liveChartFigure.test.ts`

**Interfaces:**
- Consumes: `Bar`, `hasVolumeData`, `normalizePercent` from `./liveChartBucketing` (Task 2); `PlotlyFigure`, `applyDarkLayout` from `./chartShapes` (existing).
- Produces: `ChartType = "line" | "area" | "candle"`; `buildSingleFigure(bars: Bar[], chartType: ChartType): PlotlyFigure`; `buildOverlayFigure(bySymbol: Record<string, Bar[]>, chartType: "line" | "area"): PlotlyFigure`. Task 5 imports all three by name.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/liveChartFigure.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildSingleFigure, buildOverlayFigure } from "./liveChartFigure";
import type { Bar } from "./liveChartBucketing";

const CANDLE_BARS: Bar[] = [
  { date: 0, open: 100, high: 105, low: 95, close: 102, volume: 1000 },
  { date: 60_000, open: 102, high: 103, low: 101, close: 101, volume: 500 },
];

const NO_VOLUME_BARS: Bar[] = [
  { date: 0, open: 1.08, high: 1.09, low: 1.07, close: 1.085, volume: null },
];

describe("buildSingleFigure", () => {
  it("builds a scatter line trace for chartType line", () => {
    const fig = buildSingleFigure(CANDLE_BARS, "line");
    expect(fig.data).toHaveLength(1);
    expect(fig.data[0]).toMatchObject({ type: "scatter", mode: "lines" });
  });

  it("sets fill for chartType area", () => {
    const fig = buildSingleFigure(CANDLE_BARS, "area");
    expect(fig.data[0]).toMatchObject({ fill: "tozeroy" });
  });

  it("builds a candlestick trace plus a volume subplot when volume data exists", () => {
    const fig = buildSingleFigure(CANDLE_BARS, "candle");
    expect(fig.data).toHaveLength(2);
    expect(fig.data[0]).toMatchObject({ type: "candlestick" });
    expect(fig.data[1]).toMatchObject({ type: "bar", yaxis: "y2" });
  });

  it("omits the volume subplot when the series has no volume data, even for candle", () => {
    const fig = buildSingleFigure(NO_VOLUME_BARS, "candle");
    expect(fig.data).toHaveLength(1);
  });

  it("adds the volume subplot for a line chart too, when the series has volume data", () => {
    const fig = buildSingleFigure(CANDLE_BARS, "line");
    expect(fig.data).toHaveLength(2);
    expect(fig.data[1]).toMatchObject({ type: "bar", yaxis: "y2" });
  });

  it("omits the volume subplot for a line chart when the series has no volume data", () => {
    const fig = buildSingleFigure(NO_VOLUME_BARS, "line");
    expect(fig.data).toHaveLength(1);
  });
});

describe("buildOverlayFigure", () => {
  it("builds one normalized trace per symbol, named for it", () => {
    const fig = buildOverlayFigure({ AAPL: CANDLE_BARS, "BTC-USD": CANDLE_BARS }, "line");
    expect(fig.data).toHaveLength(2);
    expect(fig.data.map((t) => (t as { name: string }).name)).toEqual(["AAPL", "BTC-USD"]);
    const y = (fig.data[0] as { y: number[] }).y;
    expect(y[0]).toBeCloseTo(2); // (102 - 100) / 100 * 100
    expect(y[1]).toBeCloseTo(1); // (101 - 100) / 100 * 100
  });

  it("sets fill for area overlays", () => {
    const fig = buildOverlayFigure({ AAPL: CANDLE_BARS }, "area");
    expect(fig.data[0]).toMatchObject({ fill: "tozeroy" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run src/lib/liveChartFigure.test.ts`
Expected: FAIL — `Cannot find module './liveChartFigure'`

- [ ] **Step 3: Implement**

Create `src/lib/liveChartFigure.ts`:

```typescript
import type { Bar } from "./liveChartBucketing";
import { hasVolumeData, normalizePercent } from "./liveChartBucketing";
import { applyDarkLayout, type PlotlyFigure } from "./chartShapes";

export type ChartType = "line" | "area" | "candle";

const UP = "#5fb37c";
const DOWN = "#d9695f";
const LINE_COLOR = "#4f8cc9";
const VOLUME_COLOR = "#3d5a80";

/** One symbol's figure: line/area/candle, with a volume subplot whenever the
 * series actually carries volume data -- follows the data, not the chart
 * type. A candle view for a forex pair has no volume strip; a line view for
 * an equity does. */
export function buildSingleFigure(bars: Bar[], chartType: ChartType): PlotlyFigure {
  const x = bars.map((b) => new Date(b.date).toISOString());
  const showVolume = hasVolumeData(bars);

  const priceTrace =
    chartType === "candle"
      ? {
          type: "candlestick",
          x,
          open: bars.map((b) => b.open),
          high: bars.map((b) => b.high),
          low: bars.map((b) => b.low),
          close: bars.map((b) => b.close),
          increasing: { line: { color: UP } },
          decreasing: { line: { color: DOWN } },
          xaxis: "x",
          yaxis: "y",
        }
      : {
          type: "scatter",
          mode: "lines",
          x,
          y: bars.map((b) => b.close),
          line: { color: LINE_COLOR },
          fill: chartType === "area" ? "tozeroy" : undefined,
          xaxis: "x",
          yaxis: "y",
        };

  if (!showVolume) {
    return {
      data: [priceTrace],
      layout: applyDarkLayout(
        chartType === "candle" ? { xaxis: { rangeslider: { visible: false } } } : {}
      ),
    };
  }

  const volumeTrace = {
    type: "bar",
    x,
    y: bars.map((b) => b.volume ?? 0),
    marker: { color: VOLUME_COLOR },
    xaxis: "x",
    yaxis: "y2",
  };

  return {
    data: [priceTrace, volumeTrace],
    layout: applyDarkLayout({
      xaxis: { rangeslider: { visible: false } },
      yaxis: { domain: [0.3, 1] },
      yaxis2: { domain: [0, 0.2] },
      grid: { rows: 2, columns: 1, subplots: [["xy"], ["xy2"]] },
      showlegend: false,
    }),
  };
}

/** Multi-symbol line/area overlay: every symbol normalized to % change from
 * its own seed open, so a $150 and a $60,000 symbol share one readable
 * axis. */
export function buildOverlayFigure(
  bySymbol: Record<string, Bar[]>,
  chartType: "line" | "area"
): PlotlyFigure {
  const data = Object.entries(bySymbol).map(([symbol, bars]) => {
    const points = normalizePercent(bars);
    return {
      type: "scatter",
      mode: "lines",
      name: symbol,
      x: points.map((p) => new Date(p.date).toISOString()),
      y: points.map((p) => p.value),
      fill: chartType === "area" ? "tozeroy" : undefined,
    };
  });
  return {
    data,
    layout: applyDarkLayout({ yaxis: { title: { text: "% change" } }, showlegend: true }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run src/lib/liveChartFigure.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/liveChartFigure.ts src/lib/liveChartFigure.test.ts
git commit -m "feat(live-chart): Plotly figure builders for single and overlay charts"
```

---

### Task 4: `LiveChartPanel` — Plotly lifecycle wrapper (bdobb)

**Worktree:** `/Users/artcashin/Developer/bdobb-live-chart`

**Files:**
- Create: `src/components/renderers/LiveChartPanel.tsx`
- Test: `src/components/renderers/LiveChartPanel.test.tsx`

**Interfaces:**
- Consumes: `PlotlyFigure` from `../../lib/chartShapes` (existing).
- Produces: `default function LiveChartPanel({ figure, title }: { figure: PlotlyFigure; title?: string })`. Task 5 renders one or more of these.

- [ ] **Step 1: Write the failing tests**

Create `src/components/renderers/LiveChartPanel.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import Plotly from "plotly.js-dist-min";
import LiveChartPanel from "./LiveChartPanel";

vi.mock("plotly.js-dist-min", () => ({
  default: { react: vi.fn(), purge: vi.fn(), Plots: { resize: vi.fn() } },
}));

const FIGURE = { data: [{ type: "scatter", x: [1], y: [2] }], layout: { title: "T" } };

beforeEach(() => vi.clearAllMocks());

describe("LiveChartPanel", () => {
  it("draws the figure with Plotly.react", () => {
    render(<LiveChartPanel figure={FIGURE} />);
    expect(vi.mocked(Plotly.react)).toHaveBeenCalledTimes(1);
    const [, data] = vi.mocked(Plotly.react).mock.calls[0];
    expect(data).toEqual(FIGURE.data);
  });

  it("redraws via react, not purge+newPlot, when the figure prop changes", () => {
    const { rerender } = render(<LiveChartPanel figure={FIGURE} />);
    const nextFigure = { data: [{ type: "scatter", x: [1, 2], y: [2, 3] }], layout: {} };
    rerender(<LiveChartPanel figure={nextFigure} />);
    expect(vi.mocked(Plotly.react)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Plotly.purge)).not.toHaveBeenCalled();
  });

  it("purges the plot on unmount", () => {
    const { unmount } = render(<LiveChartPanel figure={FIGURE} />);
    unmount();
    expect(vi.mocked(Plotly.purge)).toHaveBeenCalledTimes(1);
  });

  it("renders an optional title", () => {
    const { getByText } = render(<LiveChartPanel figure={FIGURE} title="AAPL" />);
    expect(getByText("AAPL")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run src/components/renderers/LiveChartPanel.test.tsx`
Expected: FAIL — `Cannot find module './LiveChartPanel'`

- [ ] **Step 3: Implement**

Create `src/components/renderers/LiveChartPanel.tsx`:

```tsx
import { useEffect, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import { logError } from "../../lib/logger";
import type { PlotlyFigure } from "../../lib/chartShapes";

interface LiveChartPanelProps {
  figure: PlotlyFigure;
  title?: string;
}

/**
 * Owns one Plotly node's lifecycle for a figure that changes often -- a live
 * chart re-renders on every bucketed tick. Uses Plotly.react rather than
 * ChartRenderer's purge+newPlot: react() diffs against the currently drawn
 * figure and updates in place, so a tick that only moves the last candle
 * doesn't tear down and rebuild the whole plot.
 */
export default function LiveChartPanel({ figure, title }: LiveChartPanelProps) {
  const nodeRef = useRef<HTMLDivElement>(null);

  // Redraw whenever the figure changes.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    Promise.resolve(
      Plotly.react(node, figure.data, figure.layout ?? {}, { responsive: true })
    ).catch((e) => logError(`LiveChartPanel: Plotly.react failed: ${String(e)}`));
  }, [figure]);

  // Mount/unmount only: wire the resize observer once and purge exactly on
  // unmount, not on every figure update -- an effect keyed on `figure` would
  // otherwise purge and lose the plot's zoom/pan state on every tick.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => Plotly.Plots.resize(node));
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      Plotly.purge(node);
    };
  }, []);

  return (
    <div className="live-chart-panel">
      {title && <div className="live-chart-panel-title">{title}</div>}
      <div ref={nodeRef} className="plotly-chart" />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- --run src/components/renderers/LiveChartPanel.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/renderers/LiveChartPanel.tsx src/components/renderers/LiveChartPanel.test.tsx
git commit -m "feat(live-chart): LiveChartPanel, a Plotly.react lifecycle wrapper"
```

---

### Task 5: `LiveChartRenderer` — seeding, websocket, layout (bdobb)

**Worktree:** `/Users/artcashin/Developer/bdobb-live-chart`

**Files:**
- Create: `src/components/renderers/LiveChartRenderer.tsx`
- Test: `src/components/renderers/LiveChartRenderer.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `BUCKET_MS`, `Bar`, `SeedBar`, `applyTick`, `seedToBar`, from `../../lib/liveChartBucketing` (Task 2); `ChartType`, `buildSingleFigure`, `buildOverlayFigure` from `../../lib/liveChartFigure` (Task 3); `LiveChartPanel` (Task 4); `fetchJson`, `resolveEndpoint`, `serializeParams` from `../../lib/dataClient` (existing); `BackendConfig`, `ParamValues`, `WidgetDef` from `../../lib/types` (existing).
- Produces: `default function LiveChartRenderer({ widgetDef, backend, params, theme, fetchImpl }: LiveChartRendererProps)`. Task 6 dispatches to this from `WidgetCard.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/renderers/LiveChartRenderer.test.tsx`:

```tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Plotly from "plotly.js-dist-min";
import LiveChartRenderer from "./LiveChartRenderer";
import { makeWidgetDef } from "../../test/widgetDef";
import type { BackendConfig } from "../../lib/types";

vi.mock("plotly.js-dist-min", () => ({
  default: { react: vi.fn(), purge: vi.fn(), Plots: { resize: vi.fn() } },
}));

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const backend: BackendConfig = {
  id: "b1",
  name: "Live grid backend",
  baseUrl: "https://openbb.example.ts.net:6903",
};

const widget = () =>
  makeWidgetDef({
    id: "live_chart",
    type: "live_chart",
    endpoint: "/series",
    wsEndpoint: "/live_grid_ws",
  });

function bar(date: string, close: number, volume: number | null = 10) {
  return { date, open: close, high: close, low: close, close, volume };
}

function fetchImplFor(bySymbol: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const symbol = new URL(url).searchParams.get("symbol") ?? "";
    if (!(symbol in bySymbol)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ bars: bySymbol[symbol], cache: {} }), { status: 200 });
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastSocket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

describe("LiveChartRenderer", () => {
  it("seeds one /series call per symbol and draws a figure", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/series");
    expect(calledUrl.searchParams.get("symbol")).toBe("AAPL");
    expect(calledUrl.searchParams.get("interval")).toBe("1m");
  });

  it("isolates a per-symbol seed failure in small multiples -- other symbols still render", async () => {
    // Per-symbol errors only render distinctly in small-multiples (candle)
    // layout; the overlay layout silently omits a failed symbol from the
    // combined chart rather than showing inline error text.
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] }); // MSFT missing -> 404
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL,MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => expect(screen.getByText(/HTTP 404/i)).toBeInTheDocument());
    // AAPL's own mini chart still drew.
    expect(vi.mocked(Plotly.react)).toHaveBeenCalled();
  });

  it("subscribes over the shared websocket with the joined symbol list", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());
    expect(lastSocket().sent).toEqual([JSON.stringify({ params: { symbol: "AAPL" } })]);
  });

  it("buckets an incoming tick into the seeded series", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());
    const callsBefore = vi.mocked(Plotly.react).mock.calls.length;
    act(() => lastSocket().serverMessage({ symbol: "AAPL", price: 105, last_size: 3 }));
    await waitFor(() => expect(vi.mocked(Plotly.react).mock.calls.length).toBeGreaterThan(callsBefore));
    const [, data] = vi.mocked(Plotly.react).mock.calls.at(-1)!;
    expect((data as { y: number[] }[])[0].y.at(-1)).toBe(105);
  });

  it("switches chart type without re-fetching /series", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => {
      const [, data] = vi.mocked(Plotly.react).mock.calls.at(-1)!;
      expect((data as { type: string }[])[0].type).toBe("candlestick");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still just the one seed call
  });

  it("renders small multiples for multi-symbol candle", async () => {
    const fetchImpl = fetchImplFor({
      AAPL: [bar("2026-08-07T00:00:00", 100)],
      MSFT: [bar("2026-08-07T00:00:00", 200)],
    });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL,MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    // Default chartType is line, so this starts in overlay layout, where a
    // symbol name is a Plotly trace `name`, not visible DOM text -- wait for
    // the initial draw, then switch to candle to reach small multiples.
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
      expect(screen.getByText("MSFT")).toBeInTheDocument();
    });
  });

  it("re-seeds and resubscribes when the symbol list changes", async () => {
    const fetchImpl = fetchImplFor({
      AAPL: [bar("2026-08-07T00:00:00", 100)],
      MSFT: [bar("2026-08-07T00:00:00", 200)],
    });
    const { rerender } = render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());

    rerender(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("symbol")).toBe("MSFT");
    expect(lastSocket().sent.at(-1)).toBe(JSON.stringify({ params: { symbol: "MSFT" } }));
  });

  it("shows a static seed-only chart when the widget has no wsEndpoint", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={makeWidgetDef({ id: "live_chart", type: "live_chart", endpoint: "/series", wsEndpoint: null })}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- --run src/components/renderers/LiveChartRenderer.test.tsx`
Expected: FAIL — `Cannot find module './LiveChartRenderer'`

- [ ] **Step 3: Implement**

Create `src/components/renderers/LiveChartRenderer.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, ParamValues, WidgetDef } from "../../lib/types";
import { fetchJson, resolveEndpoint, serializeParams } from "../../lib/dataClient";
import {
  applyTick, seedToBar, BUCKET_MS,
  type Bar, type SeedBar,
} from "../../lib/liveChartBucketing";
import { buildSingleFigure, buildOverlayFigure, type ChartType } from "../../lib/liveChartFigure";
import LiveChartPanel from "./LiveChartPanel";
import { logError, logOnce } from "../../lib/logger";

const RETRY_MS = 3000;
const DEFAULT_INTERVAL = "1m";

interface LiveChartRendererProps {
  widgetDef: WidgetDef;
  backend: BackendConfig | undefined;
  params: ParamValues;
  theme: "dark";
  fetchImpl?: typeof fetch;
}

interface SymbolState {
  bars: Bar[];
  loading: boolean;
  error: string | null;
}

function parseSymbols(value: ParamValues[string]): string[] {
  const s = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return s.split(",").map((sym) => sym.trim()).filter(Boolean);
}

function isSeedBarArray(x: unknown): x is SeedBar[] {
  return Array.isArray(x) && x.every((r) => r !== null && typeof r === "object" && "date" in r);
}

const CHART_TYPES: ChartType[] = ["line", "area", "candle"];

/**
 * live_chart: seeds per-symbol history from /series (one call per symbol --
 * unlike live_grid's seed endpoint, /series takes exactly one symbol), then
 * buckets the shared live_grid_ws tick stream into bars itself. Bypasses
 * WidgetCard's generic seed fetch entirely (see WidgetCard.tsx's live_chart
 * special case) because that fetch would comma-join a multi-symbol query
 * against an endpoint that only accepts one.
 */
export default function LiveChartRenderer({
  widgetDef, backend, params, theme, fetchImpl = tauriFetch,
}: LiveChartRendererProps) {
  const symbols = useMemo(() => parseSymbols(params.symbol), [params.symbol]);
  const interval = useMemo(() => String(params.interval ?? DEFAULT_INTERVAL), [params.interval]);
  const bucketMs = BUCKET_MS[interval] ?? BUCKET_MS[DEFAULT_INTERVAL];

  const [chartType, setChartType] = useState<ChartType>("line");
  const [bySymbol, setBySymbol] = useState<Record<string, SymbolState>>({});

  // Seed: one /series call per symbol, whenever the symbol list, interval,
  // or backend changes. A symbol whose call fails renders in its own error
  // state without affecting the others.
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    setBySymbol(
      Object.fromEntries(symbols.map((s) => [s, { bars: [], loading: true, error: null }]))
    );
    for (const symbol of symbols) {
      const url = resolveEndpoint(backend.baseUrl, widgetDef.endpoint);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      fetchJson(url.toString(), backend, fetchImpl)
        .then((json) => {
          if (cancelled) return;
          const raw = (json as { bars?: unknown } | null)?.bars;
          const bars = isSeedBarArray(raw) ? raw.map(seedToBar) : [];
          setBySymbol((s) => ({ ...s, [symbol]: { bars, loading: false, error: null } }));
        })
        .catch((e) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          logError(`live_chart ${widgetDef.id}: seed failed for ${symbol}: ${msg}`);
          setBySymbol((s) => ({ ...s, [symbol]: { bars: [], loading: false, error: msg } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [backend, widgetDef.endpoint, symbols, interval, fetchImpl, widgetDef.id]);

  // Live: one websocket, shared across every subscribed symbol -- same
  // protocol LiveGridRenderer uses. Each tick is routed by its own `symbol`
  // field and bucketed into that symbol's series.
  const wsUrl = useMemo(() => {
    if (!backend || !widgetDef.wsEndpoint) return null;
    const url = resolveEndpoint(backend.baseUrl, widgetDef.wsEndpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/^http/, "ws");
  }, [backend, widgetDef.wsEndpoint]);

  const subscribeMsg = useMemo(
    () => JSON.stringify({ params: serializeParams({ symbol: symbols.join(",") }) }),
    [symbols]
  );
  const subscribeRef = useRef(subscribeMsg);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    subscribeRef.current = subscribeMsg;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(subscribeMsg);
  }, [subscribeMsg]);

  useEffect(() => {
    if (!wsUrl) {
      if (widgetDef.wsEndpoint) {
        logOnce(
          `live-chart-nows-${widgetDef.id}`,
          `live_chart ${widgetDef.id}: no usable websocket URL; showing seed only`
        );
      }
      return;
    }
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      let sock: WebSocket;
      try {
        sock = new WebSocket(wsUrl);
      } catch (e) {
        logError(`live_chart ${widgetDef.id}: websocket open failed: ${String(e)}`);
        return;
      }
      wsRef.current = sock;
      sock.onopen = () => sock.send(subscribeRef.current);
      sock.onmessage = (ev: MessageEvent) => {
        let msg: unknown;
        try {
          msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        } catch {
          return;
        }
        const ticks = (Array.isArray(msg) ? msg : [msg]).filter(
          (t): t is { symbol: string } & Record<string, unknown> =>
            t !== null && typeof t === "object" && typeof (t as { symbol?: unknown }).symbol === "string"
        );
        if (ticks.length === 0) return;
        const now = Date.now();
        setBySymbol((s) => {
          let changed = false;
          const next = { ...s };
          for (const tick of ticks) {
            const cur = next[tick.symbol];
            if (!cur) continue; // not a symbol this card is displaying
            const bars = applyTick(cur.bars, tick, bucketMs, now);
            if (bars !== cur.bars) {
              next[tick.symbol] = { ...cur, bars };
              changed = true;
            }
          }
          return changed ? next : s;
        });
      };
      sock.onclose = () => {
        if (wsRef.current === sock) wsRef.current = null;
        if (!disposed) retry = setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      const sock = wsRef.current;
      wsRef.current = null;
      sock?.close();
    };
  }, [wsUrl, widgetDef.id, widgetDef.wsEndpoint, bucketMs]);

  if (symbols.length === 0) {
    return <div className="renderer-empty">No symbol selected</div>;
  }

  const single = symbols.length === 1;
  const smallMultiples = !single && chartType === "candle";

  const renderBody = () => {
    if (single) {
      const state = bySymbol[symbols[0]];
      if (!state || state.loading) return <div className="renderer-empty">Loading…</div>;
      if (state.error) return <div className="error">{state.error}</div>;
      return <LiveChartPanel figure={buildSingleFigure(state.bars, chartType)} />;
    }
    if (smallMultiples) {
      return (
        <div className="live-chart-small-multiples">
          {symbols.map((symbol) => {
            const state = bySymbol[symbol];
            if (!state || state.loading) {
              return <div key={symbol} className="renderer-empty">Loading {symbol}…</div>;
            }
            if (state.error) {
              return <div key={symbol} className="error">{symbol}: {state.error}</div>;
            }
            return (
              <LiveChartPanel key={symbol} title={symbol} figure={buildSingleFigure(state.bars, "candle")} />
            );
          })}
        </div>
      );
    }
    const ready = Object.fromEntries(
      symbols
        .filter((s) => bySymbol[s] && !bySymbol[s].loading && !bySymbol[s].error)
        .map((s) => [s, bySymbol[s].bars])
    );
    if (Object.keys(ready).length === 0) return <div className="renderer-empty">Loading…</div>;
    return <LiveChartPanel figure={buildOverlayFigure(ready, chartType === "area" ? "area" : "line")} />;
  };

  return (
    <div className={`live-chart-container ${theme}`}>
      <div className="live-chart-controls">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`live-chart-type-btn${chartType === t ? " active" : ""}`}
            onClick={() => setChartType(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {renderBody()}
    </div>
  );
}
```

- [ ] **Step 4: Add CSS**

In `src/styles.css`, add `.live-chart-container` to the existing shared renderer-root selector (find the block starting `.chart-container,\n.table-container,` around line 993):

```css
.chart-container,
.table-container,
.html-container,
.iframe-container,
.markdown-container,
.metric-container,
.raw-json-view,
.unsupported-container,
.live-chart-container {
  width: 100%; height: 100%;
  overflow: auto;
}
```

Then add new rules near the `.live-grid` block (after the `.plotly-chart` rule, around line 1004):

```css
.live-chart-container { display: flex; flex-direction: column; }
.live-chart-controls {
  display: flex; gap: 4px; padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}
.live-chart-type-btn {
  background: none; border: 1px solid var(--border); border-radius: 4px;
  color: var(--text-dim); font-size: 11px; padding: 2px 8px; cursor: pointer;
  text-transform: capitalize;
}
.live-chart-type-btn.active {
  color: var(--text); border-color: var(--accent); background: var(--bg-card);
}
.live-chart-small-multiples {
  flex: 1;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px; overflow: auto; padding: 4px;
}
.live-chart-panel { display: flex; flex-direction: column; height: 100%; min-height: 160px; }
.live-chart-panel-title { font-size: 11px; color: var(--text-dim); padding: 2px 8px; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- --run src/components/renderers/LiveChartRenderer.test.tsx`
Expected: PASS (8 tests)

- [ ] **Step 6: Run the full bdobb suite to confirm no regression**

Run: `pnpm test -- --run`
Expected: all tests pass (1068 baseline + new tests)

- [ ] **Step 7: Commit**

```bash
git add src/components/renderers/LiveChartRenderer.tsx src/components/renderers/LiveChartRenderer.test.tsx src/styles.css
git commit -m "feat(live-chart): LiveChartRenderer -- seeding, live bucketing, layout

Per-symbol /series seeding, shared live_grid_ws subscription, single/
overlay/small-multiples layout selection, chart-type toggle."
```

---

### Task 6: Wire into `WidgetCard.tsx` (bdobb)

**Worktree:** `/Users/artcashin/Developer/bdobb-live-chart`

**Files:**
- Modify: `src/components/WidgetCard.tsx`
- Modify: `src/components/WidgetCard.test.tsx`

**Interfaces:**
- Consumes: `LiveChartRenderer` (Task 5).

- [ ] **Step 1: Write the failing test**

In `src/components/WidgetCard.test.tsx`, add a mock alongside the existing `MetricRenderer` mock (around line 138):

```tsx
vi.mock("./renderers/LiveChartRenderer", () => ({
  default: ({ widgetDef }: { widgetDef: { id: string } }) => (
    <div>live-chart-rendered:{widgetDef.id}</div>
  ),
}));
```

Then add a test inside the `describe("WidgetCard", ...)` block, alongside the other dispatch tests (near the `"fetches text rather than JSON for html widgets"` test):

```tsx
  it("dispatches live_chart widgets to LiveChartRenderer and skips the generic seed fetch", async () => {
    registryType = "live_chart";
    render(<WidgetCard card={makeCard()} />);
    await screen.findByText("live-chart-rendered:w1");
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWidgetHtml)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/components/WidgetCard.test.tsx -t "dispatches live_chart"`
Expected: FAIL — the card falls through to `RawJsonView` (or the generic fetch runs) because `live_chart` isn't special-cased yet.

- [ ] **Step 3: Skip the generic seed fetch for live_chart**

`src/components/WidgetCard.tsx:162` already has this exact pattern for `iframe` widgets — a type that loads its data its own way, so the generic fetch effect must not run at all: `if (widget.type === "iframe") return;`, placed *before* `setLoading`/`setError`/`seq` are touched, relying on `data`/`loading`/`error`'s mount-time defaults (`null`/`false`/`null`) rather than setting them. `live_chart` needs the identical treatment — it fetches its own per-symbol history (`/series` takes one symbol per call; the widget's declared endpoint can't be called generically the way every other type's can) and opens its own websocket, see `LiveChartRenderer`. Add it as a sibling special case, right after the iframe one:

```tsx
    // iframe widgets load their endpoint directly in the frame; there is no
    // JSON payload to fetch, and requesting one would fail against an app URL.
    if (widget.type === "iframe") return;
    // live_chart fetches its own per-symbol history and opens its own
    // websocket (LiveChartRenderer) -- the generic single-endpoint fetch
    // below would send a comma-joined multi-symbol query against /series,
    // which only accepts one symbol per call and has no defined behavior
    // for a joined list.
    if (widget.type === "live_chart") return;
```

(The `finally` block below still runs on this early return, clearing `loading` correctly.)

- [ ] **Step 4: Add the dispatch branch**

Add the import near the existing `LiveGridRenderer` import (around line 33):

```tsx
import LiveChartRenderer from "./renderers/LiveChartRenderer";
```

Add the dispatch branch directly after the existing `live_grid` branch (around line 411, right after its closing `}`):

```tsx
    if (widget.type === "live_chart") {
      return (
        <LiveChartRenderer
          widgetDef={widgetDef}
          backend={backend}
          params={fetchParams}
          theme={theme}
        />
      );
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- --run src/components/WidgetCard.test.tsx -t "dispatches live_chart"`
Expected: PASS

- [ ] **Step 6: Run the full bdobb suite to confirm no regression**

Run: `pnpm test -- --run`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/components/WidgetCard.tsx src/components/WidgetCard.test.tsx
git commit -m "feat(live-chart): dispatch live_chart widgets to LiveChartRenderer

Also skips the generic single-endpoint seed fetch for this type --
/series takes one symbol per call, so the renderer seeds itself."
```

---

## After Task 6

Both worktrees now have a complete, tested `live_chart` feature on `feat/live-chart`. Merging to each repo's `main` and cutting the `v10.0.0` bdobb tag (per `episodes-10-12-plan.md`'s build order) is a separate step, not part of this plan.
