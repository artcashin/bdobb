import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import Plotly from "plotly.js-dist-min";
import ChartRenderer from "./ChartRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

vi.mock("plotly.js-dist-min", () => ({
  default: { newPlot: vi.fn(), purge: vi.fn() },
}));

const widgetDef = makeWidgetDef({ type: "chart" });
const FIGURE = { data: [{ x: [1, 2], y: [3, 4], type: "scatter" }], layout: { title: "T" } };

beforeEach(() => vi.clearAllMocks());

describe("ChartRenderer", () => {
  it("plots a Plotly figure payload", () => {
    render(<ChartRenderer data={FIGURE} widgetDef={widgetDef} theme="dark" />);
    expect(vi.mocked(Plotly.newPlot)).toHaveBeenCalled();
    // The traces must actually reach Plotly, not just a container be rendered.
    const [, traces] = vi.mocked(Plotly.newPlot).mock.calls[0];
    expect(traces).toEqual(FIGURE.data);
  });

  it("accepts a bare array of traces", () => {
    render(<ChartRenderer data={FIGURE.data} widgetDef={widgetDef} theme="dark" />);
    const [, traces] = vi.mocked(Plotly.newPlot).mock.calls[0];
    expect(traces).toEqual(FIGURE.data);
  });

  it("purges the plot on unmount", () => {
    const { unmount } = render(
      <ChartRenderer data={FIGURE} widgetDef={widgetDef} theme="dark" />
    );
    unmount();
    expect(vi.mocked(Plotly.purge)).toHaveBeenCalled();
  });

  it("shows an empty state when there is no data", () => {
    render(<ChartRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/No chart data available/i)).toBeInTheDocument();
  });

  it("falls back to raw JSON for a payload that is not a figure", () => {
    // Previously this left an empty .plotly-chart div — a literally blank card.
    render(
      <ChartRenderer data={{ detail: "not a figure" }} widgetDef={widgetDef} theme="dark" />
    );
    expect(screen.getByText(/not a figure/)).toBeInTheDocument();
    expect(vi.mocked(Plotly.newPlot)).not.toHaveBeenCalled();
  });

  it("recovers the record array from a `results` envelope when the dataKey dead-ended (desk Finding 5)", () => {
    // Real NAS shape: dataKey "chart.content" bottoms out at the whole
    // envelope because `chart` is null, so extractData returns it verbatim.
    // The chartable OHLC series is still sitting under `results`.
    const envelope = {
      results: [
        { date: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5 },
        { date: "2026-07-02", open: 1.5, high: 3, low: 1.4, close: 2.8 },
      ],
      chart: null,
      provider: "eodhd",
    };
    render(<ChartRenderer data={envelope} widgetDef={widgetDef} theme="dark" />);
    expect(vi.mocked(Plotly.newPlot)).toHaveBeenCalled();
    const [, traces] = vi.mocked(Plotly.newPlot).mock.calls[0];
    expect((traces as { type?: string }[])[0].type).toBe("candlestick");
    expect(document.querySelector(".raw-json-view")).not.toBeInTheDocument();
  });

  it("still falls back to raw JSON for an envelope whose `results` is not a record array", () => {
    render(
      <ChartRenderer
        data={{ results: "no rows here", chart: null }}
        widgetDef={widgetDef}
        theme="dark"
      />
    );
    expect(screen.getByText(/no rows here/)).toBeInTheDocument();
    expect(vi.mocked(Plotly.newPlot)).not.toHaveBeenCalled();
  });
});
