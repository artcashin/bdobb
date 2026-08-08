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
