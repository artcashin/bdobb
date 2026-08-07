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
