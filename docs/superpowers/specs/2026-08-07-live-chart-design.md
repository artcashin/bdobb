# Live chart — client-bucketed tick chart (Adventures in OpenBB, Ep. 10)

**Date:** 2026-08-07 · **Status:** Approved (Art, 2026-08-07)

Spans two repos, asymmetrically. **bdobb** carries all of the new logic — a
renderer, a `WidgetCard.tsx` dispatch branch, and its tests. **openbb-docker**
needs exactly one change: a new entry in `live-grid/widgets.json` declaring
the widget. No Python, no server code, no new endpoint — `GET /series` and
`live_grid_ws` already shipped as part of `v10.0.0` and are unchanged by this
spec; `widgets.json` just needs to advertise a client type they don't
currently back. The series-level framing (why Ep. 10 is the chart, not the
cache) lives in `episodes-10-12-plan.md` in the substack-articles project;
this document covers the widget itself.

## Goal

`live-grid`'s existing `kdb_cache_chart` widget (`type: "chart"`, endpoint
`/chart`) already draws a static candlestick from cached history. It has no
live dimension: opening it shows a snapshot, and it never updates again
without a manual refresh. Ep. 10's payoff is a chart that keeps drawing
itself — seeded from the same kdb cache, then extended tick by tick over the
same websocket that already drives the `live_grid` table.

This ships as a **new, additive widget** (`live_chart`), not a replacement.
`kdb_cache_chart` keeps serving OpenBB Workspace and anyone who just wants a
static history view; `live_chart` is BDOBB-only.

## Decisions taken

- **Client-side bucketing, not server re-polling** (plan doc decision #1).
  `live-grid`'s `/series` already stitches tick-derived bars onto history
  server-side (the `seam` mechanism), so re-polling `/series` on an interval
  would work — but the point of this episode is a front end that consumes a
  live tick stream directly. The renderer seeds once from `/series`, then
  buckets `live_grid_ws` ticks into bars itself. `/chart`'s pre-rendered
  Plotly figure is not used at all: it can't be extended with a client-built
  bar, only replaced wholesale.
- **Bucket boundaries use client receipt time, not the tick's `updated_at`.**
  `live_grid_ws` rows carry `updated_at` as a bare `%H:%M:%S` string with no
  date — ambiguous across a midnight rollover and not guaranteed to be the
  client's own clock. Using `Date.now()` at message-receipt time avoids
  parsing that field for anything but display.
- **Default chart type is line**, not candle. Candle is fully supported from
  first paint (the kdb seed already provides OHLC bars), but a bare last-trade
  line is the simpler default for a widget whose main job, most of the time,
  is "what's the price doing right now."
- **Chart type (line/area/candle) is local render state, not a widgets.json
  param.** It changes nothing about what's fetched — `/series` is called
  once per symbol/interval regardless of which type is selected — so it lives
  in the renderer's own state, not `fetchParams`.
- **Interval is a widgets.json param**, `1s`/`1m`/`5m`/`15m`/`30m`/`1h`/`1d`
  (mirrors `kdb-store`'s `BUCKET_NS` set), default `1m`. Changing it re-seeds
  from `/series` at the new interval and resets bucketing state, per the plan
  doc's "changing symbols re-seeds history" rule extended to interval too.
- **Volume panel visibility follows the data, not the chart type.** It shows
  whenever the active symbol's bars/ticks actually carry volume (equities,
  crypto) and stays hidden for forex, which streams bid/ask with no
  `last_size`/`volume` field at all. A candle view for a forex pair simply
  has no volume strip; a line view for an equity does.
- **Multi-symbol: line/area overlay, normalized to % change from each
  symbol's seed open.** Comma-separated symbols, matching `live_grid`'s
  existing subscription model. Raw price overlay was rejected — AAPL at ~$150
  next to BTC-USD at ~$60,000 on one axis makes the cheaper symbol
  unreadable.
- **Multi-symbol + candle: small multiples**, not a disabled control and not
  "first symbol only." One mini candlestick (+ its own volume strip, subject
  to the rule above) per symbol, each running its own independent bucketing
  state. Candle stays available at any symbol count; it just changes layout
  instead of degrading.

## Data flow

### Seed

`/series` takes exactly one `symbol` — unlike `live_grid`'s seed endpoint,
which accepts a comma-joined list in one call. `WidgetCard.tsx`'s generic
seed-fetch effect (around line 173) calls `widget.endpoint` once with
`fetchParams`, and `serializeParams` comma-joins a `multiSelect` param into a
single string — so for `live_chart` that effect would otherwise request
`GET /series?symbol=AAPL,MSFT&interval=1m`, which `/series` has no defined
behavior for.

`live_chart` is added to that effect's existing `wantsText`-style special
case (currently gating `html`/`markdown`): for `widget.type === "live_chart"`
the generic fetch is skipped entirely — `data` resolves to `null`,
`loading`/`error` clear immediately, and `LiveChartRenderer` performs its own
seeding, exactly as it already owns its own websocket rather than relying on
`WidgetCard` for that.

On mount, and on any symbol-list or interval change, `LiveChartRenderer`
itself issues one `GET /series` call per subscribed symbol, in parallel:

```
GET /series?symbol=AAPL&interval=1m
→ { symbol, interval, start, end, bars: [{date, open, high, low, close, volume}, ...], cache: {...} }
```

`bars` is used directly — not `results`, not the `/chart` figure. A symbol
whose `/series` call fails renders that one mini-chart (or the whole chart,
in single-symbol mode) in an error state; it does not take down the other
symbols in a multi-symbol subscription.

**The seed's last bar becomes the initial in-progress bucket** for that
symbol, rather than starting live bucketing from a blank bar on the first
tick. This avoids both a visible gap between "last history bar" and "first
live bar," and a duplicate bar covering the same window twice.

### Live

Opens the same `live_grid_ws` connection `LiveGridRenderer` uses (see
`src/components/renderers/LiveGridRenderer.tsx`), subscribing with the
identical `{"params": {"symbol": "A,B,C"}}` message on open and on every
symbol-list change. No separate websocket, no separate subscription
protocol.

Each incoming row (`{symbol, price, change, change_percent, bid, ask,
last_size, volume, updated_at}`) is routed by `symbol` to that instrument's
bucketing state:

1. `bucketStart = floor(Date.now() / bucketMs) * bucketMs`.
2. If `bucketStart` equals the in-progress bucket's start: `high =
   max(high, price)`, `low = min(low, price)`, `close = price`, `volume +=
   (last_size ?? 0)`.
3. If `bucketStart` is newer: the in-progress bucket is done (already
   reflected in chart state from step 2's prior updates); start a new one —
   `open = high = low = close = price`, `volume = last_size ?? 0`.
4. A tick older than the in-progress bucket (clock skew, out-of-order
   delivery) is dropped rather than reopening a finalized bar.

No bar is synthesized for a bucket window with zero ticks — a quiet
instrument just has a gap in the series, the same as any real trading chart,
rather than a flat zero-volume candle.

### Symbol / interval change

Changing either re-runs the seed step for the new symbol set/interval,
discards all in-progress bucket state, and resubscribes the websocket with
the new symbol list. This is a full reset, not an incremental diff — matches
how `LiveGridRenderer` already treats a symbol-list change (re-sends the full
`params` message; it does not track per-symbol add/remove deltas either).

## Widget declaration — openbb-docker

Additive entry in `openbb-docker/live-grid/widgets.json`, alongside the
existing `live_grid` and `kdb_cache_chart` entries. This is the only change
this spec makes outside bdobb: no Python file in `live-grid/app/` is touched,
and the service's existing test suite (`live-grid/tests/`) needs no new
coverage — `widgets.json` isn't code under test there, it's a static file
`live-grid`'s `GET /widgets.json` route already serves verbatim.

```json
"live_chart": {
  "name": "Live Chart",
  "description": "Live price chart seeded from the kdb+ cache, extended tick by tick over the live quote stream.",
  "category": "Live",
  "type": "live_chart",
  "endpoint": "series",
  "wsEndpoint": "live_grid_ws",
  "gridData": { "w": 40, "h": 16 },
  "params": [
    { "paramName": "symbol", "type": "text", "value": "AAPL", "label": "Symbols", "description": "Comma-separated: US equities, crypto (BTC-USD), forex (EURUSD)", "multiSelect": true },
    { "paramName": "interval", "type": "text", "value": "1m", "label": "Interval",
      "options": [
        { "label": "1 second", "value": "1s" }, { "label": "1 minute", "value": "1m" },
        { "label": "5 min", "value": "5m" }, { "label": "15 min", "value": "15m" },
        { "label": "30 min", "value": "30m" }, { "label": "1 hour", "value": "1h" },
        { "label": "1 day", "value": "1d" }
      ]
    }
  ],
  "source": ["EODHD", "kdb+"]
}
```

No server-side change is required to add this — `live-grid` already serves
`/series` and `/live_grid_ws`; this is a data-only `widgets.json` entry, plus
new bdobb code to actually render it.

## Renderer

New `src/components/renderers/LiveChartRenderer.tsx`, dispatched from
`WidgetCard.tsx` by `widget.type === "live_chart"` — a new branch alongside
the existing `live_grid` one (around line 399), receiving `widgetDef`,
`backend`, `params` (the parsed `fetchParams`, for the current symbol list
and interval), `theme`. The `data` prop is unused (always `null`, per the
seed-skip above) — the renderer fetches every subscribed symbol's `/series`
itself rather than receiving a pre-fetched seed.

It does **not** reuse `ChartRenderer`/`chartShapes.ts`: those build a static
Plotly figure from a single snapshot via `Plotly.newPlot`/`purge` on every
`data` change, with no notion of appending to an already-drawn trace.
`LiveChartRenderer` owns its own Plotly lifecycle — mount once, then extend
the existing figure's `x`/`open`/`high`/`low`/`close`/`y` arrays in place as
buckets update, calling `Plotly.extendTraces`/`Plotly.relayout` rather than a
full redraw on every tick. `applyDarkLayout` from `chartShapes.ts` is reused
for theming (it's a pure layout-merge helper, not coupled to the snapshot
render path).

Local component state:

- `chartType: "line" | "area" | "candle"` (default `"line"`), a segmented
  control in the card header.
- Per-symbol bucketing state (bars array + in-progress bucket), keyed by
  symbol — independent per symbol so a small-multiples layout's charts don't
  interfere with each other.

Layout: single symbol renders one chart (+ volume strip per the visibility
rule); 2+ symbols with line/area render one overlaid chart (normalized
series); 2+ symbols with candle render a small-multiples grid, one
chart(+volume) per symbol.

Websocket handling (reconnect after `LiveGridRenderer`'s `RETRY_MS = 3000`,
no socket opened if `widget.wsEndpoint` is absent, static seed-only chart in
that case) mirrors `LiveGridRenderer` exactly — no new reconnect logic.

## Testing

**bdobb (vitest), mirroring `LiveGridRenderer.test.tsx`'s conventions:**

- Seed: one `/series` fetch per symbol; a multi-symbol seed with one symbol's
  fetch rejecting still renders the other symbols' charts.
- Bucketing: a sequence of fixture ticks within one bucket window updates
  high/low/close/volume without creating a new bar; a tick past the bucket
  boundary finalizes the current bar and starts a new one seeded from that
  tick's price; an out-of-order (older) tick is dropped, not applied.
- Volume: summed from `last_size` across ticks in a bucket, not read from the
  cumulative `volume` field; volume panel absent for a forex symbol's ticks
  (no `last_size`), present for equity/crypto.
- Chart type: default render is line; switching to candle/area re-renders
  from the same bucketed bar state without re-fetching `/series`.
- Multi-symbol overlay: line/area series are normalized to % change from
  each symbol's first seed bar's open, not raw price.
- Multi-symbol + candle: renders one mini-chart per symbol (small multiples),
  not a disabled control and not a first-symbol-only chart.
- Symbol/interval change: triggers a fresh `/series` seed, clears prior
  bucket state, and resends the websocket subscribe message with the new
  symbol list.
- Websocket lifecycle: no socket opened when `wsEndpoint` is missing;
  reconnect after `RETRY_MS` on close, matching `LiveGridRenderer`.

## Out of scope

- Any change to `live-grid`'s Python app, `kdb-store`, or `openbb-kdb` — the
  backend for this episode shipped as `v10.0.0` already. `widgets.json` is
  the one openbb-docker file this spec touches, and it's data, not code.
- Changing or removing the existing `kdb_cache_chart` widget.
- Persisting the chart-type selection across a reload (local state only;
  reopening the card resets to the default).
- Backfilling empty bars for bucket windows with no ticks.
- A `raw` view or Rita context-sharing change — `live_chart` follows the
  same default behavior as any other chart-type widget; no exclusion is
  needed the way `keys` widgets needed one.

## Roll-up

Not applicable in the usual sense: bdobb's fixes-roll-into-every-tag
convention applies to changes on widget types that already exist across the
v3–v9 chain. `live_chart` is new as of this episode, so it ships starting at
whichever tag `v10.0.0` becomes and forward — it has no v3–v9 counterpart to
backport into.
