import { describe, expect, it } from "vitest";
import fixtures from "../test/fixtures/widgets.fixture.json";
import { parseWidgetEntry, parseWidgetsJson } from "./widgets";

describe("parseWidgetsJson", () => {
  const widgets = parseWidgetsJson(fixtures);
  const byId = Object.fromEntries(widgets.map((w) => [w.id, w]));

  it("parses all four fixture entries", () => {
    expect(widgets).toHaveLength(4);
    expect(Object.keys(byId).sort()).toEqual([
      "equity_price_historical_eodhd_obb",
      "equity_price_historical_eodhd_obb_chart",
      "imf_utils_presentation_table_custom_obb",
      "portfolio_iframe",
    ]);
  });

  it("normalizes the table widget", () => {
    const w = byId["equity_price_historical_eodhd_obb"];
    expect(w.type).toBe("table");
    expect(w.endpoint).toBe("/api/v1/equity/price/historical");
    expect(w.dataKey).toBe("results");
    expect(w.source).toEqual(["Eodhd"]);
    expect(w.gridData).toEqual({ w: 40, h: 15 });
    expect(w.columnsDefs).toHaveLength(8);
    expect(w.columnsDefs![0]).toMatchObject({
      field: "date",
      pinned: "left",
      cellDataType: "date",
    });
    const symbol = w.params.find((p) => p.paramName === "symbol")!;
    expect(symbol.multiSelect).toBe(true); // multiSelect || multiple
    expect(symbol.show).toBe(true);
    const interval = w.params.find((p) => p.paramName === "interval")!;
    expect(interval.options).toHaveLength(6);
    expect(interval.options![3]).toEqual({ label: "1d", value: "1d" });
    const provider = w.params.find((p) => p.paramName === "provider")!;
    expect(provider.show).toBe(false); // hidden but still sent
    expect(provider.value).toBe("eodhd");
    expect(provider.type).toBe("text"); // type defaults to text
    expect(provider.label).toBe("provider"); // label defaults to paramName
  });

  it("normalizes the html widget", () => {
    const w = byId["imf_utils_presentation_table_custom_obb"];
    expect(w.type).toBe("html");
    expect(w.raw).toBe(true);
    expect(w.refetchInterval).toBe(false);
    expect(w.dataKey).toBeNull(); // empty-string dataKey -> null
    const table = w.params.find((p) => p.paramName === "table")!;
    expect(table.type).toBe("endpoint");
    expect(table.optionsEndpoint).toBe("/api/v1/imf_utils/presentation_table_choices");
    expect(table.optionsParams).toEqual({ dataflow_group: "$dataflow_group" });
  });

  it("normalizes the chart widget", () => {
    const w = byId["equity_price_historical_eodhd_obb_chart"];
    expect(w.type).toBe("chart");
    expect(w.dataKey).toBe("chart.content");
    const chartParam = w.params.find((p) => p.paramName === "chart")!;
    expect(chartParam.show).toBe(false);
    expect(chartParam.value).toBe(true);
  });

  it("keeps iframe endpoint verbatim and extracts mcpUrl", () => {
    const w = byId["portfolio_iframe"];
    expect(w.type).toBe("iframe");
    expect(w.endpoint).toBe("http://localhost:8501"); // NOT slash-normalized
    expect(w.mcpUrl).toBe("http://localhost:7769/mcp");
    expect(w.source).toEqual(["Streamlit Demo"]); // string -> array
    expect(w.raw).toBe(false);
    expect(w.columnsDefs).toBeNull();
  });

  it("returns [] for non-object input", () => {
    expect(parseWidgetsJson(null)).toEqual([]);
    expect(parseWidgetsJson([1, 2])).toEqual([]);
    expect(parseWidgetsJson("nope")).toEqual([]);
  });
});

describe("parseWidgetEntry defaults", () => {
  it("applies protocol defaults for a minimal entry", () => {
    const w = parseWidgetEntry("min_widget", {
      name: "Minimal",
      endpoint: "api/no/leading/slash",
    });
    expect(w.type).toBe("table"); // type defaults to table
    expect(w.endpoint).toBe("/api/no/leading/slash"); // leading slash added
    expect(w.category).toBe("Other");
    expect(w.subCategory).toBeNull();
    expect(w.source).toEqual([]);
    expect(w.runButton).toBe(false);
    expect(w.raw).toBe(false);
    expect(w.refetchInterval).toBeNull();
    expect(w.params).toEqual([]);
    expect(w.gridData).toEqual({ w: 20, h: 12 }); // fallback size
    expect(w.dataKey).toBeNull();
    expect(w.mcpUrl).toBeNull();
  });
});
