import type { WidgetDef } from "./types";

export interface PlotlyFigure {
  data: unknown[];
  layout: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/** Keys that distinguish a Plotly trace from an arbitrary record. */
const TRACE_KEYS = ["x", "y", "z", "type", "mode", "values", "labels", "open", "close"];

/**
 * OpenBB's charting endpoints return a figure directly; render it as-is.
 *
 * Testing only for an array `data` was too weak: a perfectly ordinary table
 * response shaped `{ data: [ {symbol, price}, … ] }` matched, so it was handed
 * to Plotly as a trace list and drew an empty plot instead of falling through
 * to the table renderer. A real figure's entries are traces, which carry at
 * least one plotting key.
 */
export function isPlotlyFigure(x: unknown): x is PlotlyFigure {
  if (typeof x !== "object" || x === null) return false;
  const data = (x as PlotlyFigure).data;
  if (!Array.isArray(data)) return false;
  // An empty data array is a legitimate — if blank — figure, but only when the
  // object also looks like one.
  if (data.length === 0) return "layout" in (x as object);
  return data.every(
    (t) =>
      t !== null &&
      typeof t === "object" &&
      TRACE_KEYS.some((k) => k in (t as object))
  );
}

// structuredClone is available in every runtime this app targets (Tauri's
// webview, Node 18+ test runner); JSON round-trip is the fallback in case a
// future test environment lacks it.
function cloneAxis(axis: unknown): Record<string, unknown> {
  if (axis === null || typeof axis !== "object") return {};
  return typeof structuredClone === "function"
    ? structuredClone(axis as Record<string, unknown>)
    : (JSON.parse(JSON.stringify(axis)) as Record<string, unknown>);
}

export function applyDarkLayout(layout: Record<string, unknown>): Record<string, unknown> {
  // Axis objects are deep-cloned, not shallow-spread: Plotly writes back into
  // `layout.xaxis`'s nested objects (e.g. `rangeslider`) on zoom/pan, and a
  // shallow copy would still share those nested references with the caller's
  // original layout.
  return {
    ...layout,
    plot_bgcolor: "#1e1e1e",
    paper_bgcolor: "#1e1e1e",
    font: { ...(layout.font as Record<string, unknown> | undefined), color: "#d8dee9" },
    xaxis: { ...cloneAxis(layout.xaxis), gridcolor: "#2a3441" },
    yaxis: { ...cloneAxis(layout.yaxis), gridcolor: "#2a3441" },
    margin: { l: 48, r: 16, t: 24, b: 36, ...(layout.margin as Record<string, unknown> | undefined) },
  };
}

const DATE_NAME = /^(date|time|timestamp|datetime|period|dt)$/i;

function looksLikeDate(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== "string") return false;
  // Require a date-shaped string rather than trusting Date.parse, which
  // accepts things like "Apple" on some engines and every bare number.
  if (!/^\d{4}-\d{2}(-\d{2})?([T ]|$)/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** The column a time series is plotted against, or null if there isn't one. */
export function detectDateColumn(records: Record<string, unknown>[]): string | null {
  if (records.length === 0) return null;
  const keys = Object.keys(records[0]);

  // A conventionally-named column wins even if the values are unusual.
  const named = keys.find((k) => DATE_NAME.test(k));
  if (named) return named;

  return keys.find((k) => records.every((r) => looksLikeDate(r[k]))) ?? null;
}

/** Case-insensitive open/high/low/close, or null when any is missing. */
export function detectOhlc(
  records: Record<string, unknown>[]
): { open: string; high: string; low: string; close: string } | null {
  if (records.length === 0) return null;
  const keys = Object.keys(records[0]);
  const find = (name: string) => keys.find((k) => k.toLowerCase() === name);

  const open = find("open");
  const high = find("high");
  const low = find("low");
  const close = find("close");
  return open && high && low && close ? { open, high, low, close } : null;
}

/**
 * Builds a figure from table-shaped rows: a candlestick when OHLC columns are
 * present, otherwise a line over the first numeric column.
 *
 * Returns null when there is no date/time column — without one there is no
 * meaningful x axis, and the spec only offers the toggle to widgets that have
 * one.
 */
export function buildFigureFromRecords(
  records: Record<string, unknown>[]
): PlotlyFigure | null {
  if (!Array.isArray(records) || records.length === 0) return null;
  if (typeof records[0] !== "object" || records[0] === null) return null;

  const dateCol = detectDateColumn(records);
  if (!dateCol) return null;

  const x = records.map((r) => r[dateCol]);
  const ohlc = detectOhlc(records);

  if (ohlc) {
    return {
      data: [
        {
          type: "candlestick",
          x,
          open: records.map((r) => r[ohlc.open]),
          high: records.map((r) => r[ohlc.high]),
          low: records.map((r) => r[ohlc.low]),
          close: records.map((r) => r[ohlc.close]),
          increasing: { line: { color: "#5fb37c" } },
          decreasing: { line: { color: "#d9695f" } },
        },
      ],
      layout: applyDarkLayout({ xaxis: { rangeslider: { visible: false } } }),
    };
  }

  const numericCol = Object.keys(records[0]).find(
    (k) => k !== dateCol && records.some((r) => typeof r[k] === "number")
  );
  if (!numericCol) return null;

  return {
    data: [
      {
        type: "scatter",
        mode: "lines",
        name: numericCol,
        x,
        y: records.map((r) => r[numericCol]),
        line: { color: "#4f8cc9" },
      },
    ],
    layout: applyDarkLayout({ yaxis: { title: { text: numericCol } } }),
  };
}

/**
 * Whether a table widget should offer the chart view before its data loads.
 * Decided from the declared columns; WidgetCard also offers the toggle when a
 * figure can actually be built from the rows in hand, since many widgets.json
 * entries omit columnsDefs entirely.
 */
export function canToggleChart(widget: WidgetDef): boolean {
  if (widget.type === "chart") return false; // already a chart
  if (widget.type !== "table") return false;
  const defs = widget.columnsDefs;
  if (!defs) return false;
  // Defence in depth: widgets.ts filters these, but this runs during render
  // and a throw here escapes WidgetCard's error boundary.
  return defs.some((c) => {
    if (c == null || typeof c !== "object") return false;
    const { field, cellDataType } = c as { field?: unknown; cellDataType?: unknown };
    return (
      (typeof field === "string" && DATE_NAME.test(field)) ||
      cellDataType === "date" ||
      cellDataType === "dateString"
    );
  });
}
