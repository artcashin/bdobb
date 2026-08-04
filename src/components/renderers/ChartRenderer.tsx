import { useEffect, useMemo, useRef } from "react";
import Plotly from "plotly.js-dist-min";
import type { WidgetDef } from "../../lib/types";
import { logError } from "../../lib/logger";
import RawJsonView from "./RawJsonView";
import { applyDarkLayout, buildFigureFromRecords, isPlotlyFigure } from "../../lib/chartShapes";

function isRecordArray(x: unknown): x is Record<string, unknown>[] {
  return (
    Array.isArray(x) &&
    (x.length === 0 || (typeof x[0] === "object" && x[0] !== null))
  );
}

/**
 * Four shapes reach here:
 *   1. An openbb-charting Plotly figure — render as-is.
 *   2. A bare array of traces — wrap it.
 *   3. Table-shaped rows — generate a candlestick or line (spec path (b)).
 *   4. A whole response envelope — recover the rows under `results`.
 */
function asFigure(data: unknown): { data: unknown[]; layout?: Record<string, unknown> } | null {
  if (isPlotlyFigure(data)) return data;

  if (Array.isArray(data)) {
    // Rows of records are table data, not traces. A trace is an object with
    // plotting keys; a record has arbitrary business columns.
    const first = data[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const looksLikeTrace = "x" in first || "y" in first || "type" in first;
      if (!looksLikeTrace) {
        return buildFigureFromRecords(data as Record<string, unknown>[]);
      }
    }
    return { data, layout: {} };
  }

  // Desk Finding 5: the live chart envelope is `{results: [...], chart: null,
  // ...}` — a dataKey like "chart.content" dead-ends (`chart` is null), so
  // extractData hands back the whole envelope, which is neither a figure nor
  // an array. Recover the record array OpenBB conventionally puts under
  // `results` before giving up on a chart.
  if (data !== null && typeof data === "object" && "results" in data) {
    const results = (data as Record<string, unknown>).results;
    if (isRecordArray(results)) {
      return buildFigureFromRecords(results);
    }
  }

  return null;
}

interface ChartRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function ChartRenderer({ data, widgetDef, theme }: ChartRendererProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  // Whether a plot currently occupies the node, so it is purged before replot.
  const plotted = useRef(false);

  // asFigure is a dependency of the plotting effect, so an unmemoized call
  // returns a new object every render and makes the effect purge and replot on
  // each one — a full Plotly teardown/rebuild for a parent re-render that did
  // not touch the data. It also walks every row when the payload is table
  // shaped.
  const figure = useMemo(() => asFigure(data), [data]);

  useEffect(() => {
    // Capture the node: React may have detached the ref by the time cleanup
    // runs, in which case reading chartRef.current there silently skips the
    // purge and leaks the Plotly instance.
    const node = chartRef.current;
    if (!node || !figure) return;

    // applyDarkLayout deep-clones the axis objects before touching them --
    // Plotly writes back into layout.xaxis/yaxis (e.g. rangeslider) on
    // zoom/pan, and a shallow spread would leave those nested objects shared
    // with the memoized `figure.layout`, so a zoom in one card could mutate
    // state read by another render of the same data.
    const layout =
      theme === "dark"
        ? applyDarkLayout(figure.layout ?? {})
        : (figure.layout ?? {});

    if (plotted.current) {
      Plotly.purge(node);
    }
    plotted.current = true;

    let cancelled = false;
    Promise.resolve(
      Plotly.newPlot(node, figure.data, layout, { responsive: true })
    ).catch((e) => {
      logError(`Plotly render failed: ${String(e)}`);
      // Plotly rejected without drawing anything -- leave a visible message
      // instead of a silently blank .plotly-chart.
      if (cancelled) return;
      node.textContent = "Failed to render chart.";
      node.classList.add("error-box");
    });

    // config.responsive only wires up a `window` resize listener -- a card
    // resized by react-grid-layout (no window resize event) would otherwise
    // stay pinned at its mount-time pixel size. jsdom has no real
    // ResizeObserver; the test-setup stub's no-op observe() means this never
    // actually fires under test.
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => Plotly.Plots.resize(node));
      observer.observe(node);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      Plotly.purge(node);
      plotted.current = false;
    };
  }, [figure, theme, widgetDef.id]);

  if (data === null || data === undefined) {
    return <div className="renderer-empty">No chart data available</div>;
  }

  // Spec: an unexpected response shape renders raw JSON, never a blank card.
  if (!figure) {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  return (
    <div className={`chart-container ${theme}`}>
      <div ref={chartRef} className="plotly-chart" />
    </div>
  );
}