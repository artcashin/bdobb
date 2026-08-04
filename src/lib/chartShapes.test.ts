import { describe, expect, it } from "vitest";
import {
  isPlotlyFigure,
  applyDarkLayout,
  detectDateColumn,
  detectOhlc,
  buildFigureFromRecords,
  canToggleChart,
} from "./chartShapes";
import type { WidgetDef } from "./types";
import { makeWidgetDef } from "../test/widgetDef";
import historicalFixture from "../test/fixtures/historical.fixture.json";

const OHLC_ROWS = [
  { date: "2026-07-01", open: 293.44, high: 296.1, low: 292.0, close: 294.38, volume: 50164200 },
  { date: "2026-07-02", open: 294.12, high: 309.0, low: 293.5, close: 308.63, volume: 75352800 },
];

const SERIES_ROWS = [
  { date: "2026-07-01", value: 100 },
  { date: "2026-07-02", value: 120 },
];

describe("isPlotlyFigure", () => {
  it("accepts an openbb-charting figure", () => {
    expect(isPlotlyFigure({ data: [{ x: [1], y: [2] }], layout: {} })).toBe(true);
  });

  it("rejects table rows and non-objects", () => {
    expect(isPlotlyFigure(SERIES_ROWS)).toBe(false);
    expect(isPlotlyFigure(null)).toBe(false);
    expect(isPlotlyFigure("nope")).toBe(false);
  });
});

describe("detectDateColumn", () => {
  it("finds a conventionally-named column", () => {
    expect(detectDateColumn(SERIES_ROWS)).toBe("date");
    expect(detectDateColumn([{ timestamp: "2026-07-01", v: 1 }])).toBe("timestamp");
  });

  it("finds an unconventionally-named column by its values", () => {
    expect(detectDateColumn([{ asOf: "2026-07-01", v: 1 }])).toBe("asOf");
  });

  it("does not mistake plain strings or numbers for dates", () => {
    // Date.parse accepts a lot of nonsense; a bare number or a word must not
    // become the x axis.
    expect(detectDateColumn([{ name: "Apple", price: 1.29 }])).toBeNull();
    expect(detectDateColumn([{ year: 2026, price: 1.29 }])).toBeNull();
  });

  it("returns null for an empty set", () => {
    expect(detectDateColumn([])).toBeNull();
  });
});

describe("detectOhlc", () => {
  it("matches case-insensitively", () => {
    expect(detectOhlc([{ Open: 1, HIGH: 2, low: 3, Close: 4 }])).toEqual({
      open: "Open", high: "HIGH", low: "low", close: "Close",
    });
  });

  it("requires all four", () => {
    expect(detectOhlc([{ open: 1, high: 2, low: 3 }])).toBeNull();
  });
});

describe("buildFigureFromRecords", () => {
  it("builds a candlestick when OHLC columns are present", () => {
    const fig = buildFigureFromRecords(OHLC_ROWS)!;
    expect(fig).not.toBeNull();
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("candlestick");
    expect(trace.x).toEqual(["2026-07-01", "2026-07-02"]);
    expect(trace.close).toEqual([294.38, 308.63]);
  });

  it("builds a line over the first numeric column otherwise", () => {
    const fig = buildFigureFromRecords(SERIES_ROWS)!;
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("scatter");
    expect(trace.name).toBe("value");
    expect(trace.y).toEqual([100, 120]);
  });

  it("returns null without a date column — there is no x axis", () => {
    expect(buildFigureFromRecords([{ name: "Apple", price: 1.29 }])).toBeNull();
  });

  it("returns null when the only other column is non-numeric", () => {
    expect(buildFigureFromRecords([{ date: "2026-07-01", label: "x" }])).toBeNull();
  });

  it("returns null for empty or non-record input", () => {
    expect(buildFigureFromRecords([])).toBeNull();
    expect(buildFigureFromRecords([1, 2] as unknown as Record<string, unknown>[])).toBeNull();
  });

  it("does not build a candlestick from a partial OHLC set", () => {
    // Only `close` is present -- detectOhlc should reject this, falling
    // through to the numeric-column (line) path instead of a candlestick
    // with undefined open/high/low arrays.
    const fig = buildFigureFromRecords([
      { date: "2026-01-01", close: 10 },
      { date: "2026-01-02", close: 11 },
    ])!;
    expect(fig).not.toBeNull();
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("scatter");
  });

  it("detects OHLC and date columns case-insensitively end to end", () => {
    const fig = buildFigureFromRecords([
      { Date: "2026-01-01", Open: 1, High: 2, Low: 0.5, Close: 1.5 },
      { Date: "2026-01-02", Open: 1.5, High: 2.5, Low: 1, Close: 2 },
    ])!;
    expect(fig).not.toBeNull();
    const trace = fig.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("candlestick");
    expect(trace.close).toEqual([1.5, 2]);
  });

  it("finds the numeric column from later rows when the first row's value is null", () => {
    // Row 0's `value` is null -- a first-row-only value sample would
    // conclude there's no numeric column and bail out.
    const fig = buildFigureFromRecords([
      { date: "2026-01-01", value: null },
      { date: "2026-01-02", value: 5 },
      { date: "2026-01-03", value: 6 },
    ]);
    expect(fig).not.toBeNull();
    const trace = fig!.data[0] as Record<string, unknown>;
    expect(trace.type).toBe("scatter");
    expect(trace.y).toEqual([null, 5, 6]);
  });

  it("handles the recorded historical fixture", () => {
    // Real OpenBB equity price data, not a hand-built row set.
    const rows = (Array.isArray(historicalFixture)
      ? historicalFixture
      : (historicalFixture as { results?: unknown[] }).results) as Record<string, unknown>[];
    const fig = buildFigureFromRecords(rows)!;
    expect(fig).not.toBeNull();
    expect((fig.data[0] as Record<string, unknown>).type).toBe("candlestick");
  });
});

describe("applyDarkLayout", () => {
  it("keeps caller layout while forcing the dark palette", () => {
    const out = applyDarkLayout({ title: "T", xaxis: { title: "x" } });
    expect(out.title).toBe("T");
    expect((out.xaxis as Record<string, unknown>).title).toBe("x");
    expect(out.paper_bgcolor).toBe("#1e1e1e");
  });

  it("forces the dark background over a caller-supplied light template", () => {
    // Pin the deliberate precedence decision: theme colors always win, so a
    // light-template figure can't leave a white background on a dark card.
    const out = applyDarkLayout({ paper_bgcolor: "#ffffff", plot_bgcolor: "#ffffff" });
    expect(out.paper_bgcolor).toBe("#1e1e1e");
    expect(out.plot_bgcolor).toBe("#1e1e1e");
  });

  it("merges the dark gridcolor into the caller's axis instead of discarding it", () => {
    // Reproduces the generated candlestick's own layout exactly.
    const out = applyDarkLayout({ xaxis: { rangeslider: { visible: false } } });
    expect(out.xaxis).toEqual({ rangeslider: { visible: false }, gridcolor: "#2a3441" });
  });

  it("does not mutate the caller's axis objects (Plotly writes into them on zoom)", () => {
    const callerXaxis = { rangeslider: { visible: false } };
    const out = applyDarkLayout({ xaxis: callerXaxis });
    expect(out.xaxis).not.toBe(callerXaxis);
    const outXaxis = out.xaxis as { rangeslider: { visible: boolean } };
    outXaxis.rangeslider.visible = true;
    expect(callerXaxis.rangeslider.visible).toBe(false);
  });
});

describe("canToggleChart", () => {
  const withCols = (defs: unknown) =>
    makeWidgetDef({ type: "table", columnsDefs: defs as WidgetDef["columnsDefs"] });

  it("is true for a table declaring a date column", () => {
    expect(canToggleChart(withCols([{ field: "date" }, { field: "close" }]))).toBe(true);
    expect(canToggleChart(withCols([{ field: "asOf", cellDataType: "date" }]))).toBe(true);
  });

  it("is false without one", () => {
    expect(canToggleChart(withCols([{ field: "name" }, { field: "price" }]))).toBe(false);
    expect(canToggleChart(withCols(null))).toBe(false);
  });

  it("is false for a widget that is already a chart", () => {
    // Redundant on purpose: WidgetCard's call site already ORs in
    // `widget.type === "chart"` before consulting this predicate, so this
    // function only has to answer "should a *table* widget offer the
    // toggle" -- unlike desk, which folds the chart-type check in here.
    expect(canToggleChart(makeWidgetDef({ type: "chart" }))).toBe(false);
  });

  it("matches the date-key column name case-insensitively", () => {
    expect(canToggleChart(withCols([{ field: "Date" }]))).toBe(true);
  });

  it("is false for a non-table widget even when its columnsDefs would otherwise qualify", () => {
    expect(
      canToggleChart(
        makeWidgetDef({ type: "html", columnsDefs: [{ field: "date", cellDataType: "date" }] })
      )
    ).toBe(false);
  });
});

describe("isPlotlyFigure discrimination", () => {
  it("accepts a real figure", () => {
    expect(isPlotlyFigure({ data: [{ type: "scatter", x: [1], y: [2] }], layout: {} })).toBe(true);
  });

  it("rejects a table response that merely has a data array", () => {
    // { data: [ {symbol, price} ] } used to pass, so an ordinary table payload
    // was handed to Plotly as a trace list and drew a blank plot instead of
    // falling through to the table renderer.
    expect(isPlotlyFigure({ data: [{ symbol: "AAPL", price: 1 }] })).toBe(false);
  });

  it("accepts an empty figure only when it is otherwise figure shaped", () => {
    expect(isPlotlyFigure({ data: [], layout: {} })).toBe(true);
    expect(isPlotlyFigure({ data: [] })).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isPlotlyFigure(null)).toBe(false);
    expect(isPlotlyFigure([{ x: 1 }])).toBe(false);
  });
});
