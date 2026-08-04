import { useMemo } from "react";
import type { WidgetDef } from "../../lib/types";
import RawJsonView from "./RawJsonView";

interface MetricRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function MetricRenderer({ data, widgetDef, theme }: MetricRendererProps) {
  const formattedValue = useMemo(() => {
    if (typeof data !== "number") return null;

    const prefix = widgetDef.columnsDefs?.[0]?.prefix || "";
    const suffix = widgetDef.columnsDefs?.[0]?.suffix || "";
    const decimalPlaces = widgetDef.columnsDefs?.[0]?.decimalPlaces || 2;

    const formatted = data.toLocaleString("en-US", {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    });

    return `${prefix}${formatted}${suffix}`;
  }, [data, widgetDef.columnsDefs]);

  if (data === null || data === undefined) {
    return <div className="renderer-empty">No data available</div>;
  }

  // A non-numeric payload is a shape mismatch, not a missing value: show the
  // response rather than a misleading "N/A".
  if (formattedValue === null) {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  return (
    <div className={`metric-container ${theme}`}>
      <span className="metric-value">{formattedValue}</span>
    </div>
  );
}