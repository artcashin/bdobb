import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import RawJsonView from "./RawJsonView";

describe("RawJsonView", () => {
  it("renders JSON with pretty print", () => {
    const data = { name: "test", value: 123, items: [1, 2, 3] };

    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "custom",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    };

    render(<RawJsonView data={data} widgetDef={widgetDef} theme="dark" />);

    expect(document.querySelector(".raw-json-view pre")).toBeInTheDocument();
  });

  it("handles null data", () => {
    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "custom",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    };

    render(<RawJsonView data={null} widgetDef={widgetDef} theme="dark" />);

    expect(screen.getByText("No data available")).toBeInTheDocument();
  });

  it("handles error state", () => {
    const data = { test: "value" };

    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "custom",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    };

    render(<RawJsonView data={data} widgetDef={widgetDef} theme="dark" />);

    expect(document.querySelector(".raw-json-view pre")).toBeInTheDocument();
  });
});