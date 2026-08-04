import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import UnsupportedRenderer from "./UnsupportedRenderer";

describe("UnsupportedRenderer", () => {
  it("renders 'Unsupported in v1' message", () => {
    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "multi_file_viewer",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      backendId: "test",
    };

    render(<UnsupportedRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    expect(screen.getByText("Unsupported in v1")).toBeInTheDocument();
  });

  it("handles pdf widget type", () => {
    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "pdf",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      backendId: "test",
    };

    render(<UnsupportedRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    expect(screen.getByText("Unsupported in v1")).toBeInTheDocument();
  });

  it("supports dark theme", () => {
    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "multi_file_viewer",
      endpoint: "/test",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      backendId: "test",
    };

    render(<UnsupportedRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    expect(screen.getByText("Unsupported in v1")).toBeInTheDocument();
  });
});