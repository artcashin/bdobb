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
    const fig = buildSingleFigure(NO_VOLUME_BARS, "line");
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
