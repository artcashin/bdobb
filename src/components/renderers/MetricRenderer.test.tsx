import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import MetricRenderer from "./MetricRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const widgetDef = makeWidgetDef({ type: "metric" });

describe("MetricRenderer", () => {
  it("renders a formatted metric value", () => {
    render(<MetricRenderer data={12345.67} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText("12,345.67")).toBeInTheDocument();
  });

  it("applies prefix, suffix and decimal places from columnsDefs", () => {
    const def = makeWidgetDef({
      type: "metric",
      columnsDefs: [{ field: "v", prefix: "$", suffix: "M", decimalPlaces: 1 }] as any,
    });
    render(<MetricRenderer data={1234.56} widgetDef={def} theme="dark" />);
    expect(screen.getByText("$1,234.6M")).toBeInTheDocument();
  });

  it("shows an empty state when there is no value", () => {
    render(<MetricRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/No data available/i)).toBeInTheDocument();
  });

  it("falls back to raw JSON for a non-numeric payload", () => {
    // Spec: an unexpected shape renders raw JSON rather than a misleading
    // "N/A" that looks like a legitimately missing value.
    render(
      <MetricRenderer data={{ value: 42, label: "x" }} widgetDef={widgetDef} theme="dark" />
    );
    expect(screen.getByText(/"value": 42/)).toBeInTheDocument();
    expect(screen.queryByText("N/A")).not.toBeInTheDocument();
  });
});
