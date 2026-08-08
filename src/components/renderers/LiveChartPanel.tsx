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
