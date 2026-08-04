import { useMemo } from "react";
import type { WidgetDef } from "../../lib/types";

interface RawJsonViewProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function RawJsonView({ data, theme }: RawJsonViewProps) {
  const jsonString = useMemo(() => {
    if (data === null || data === undefined) {
      return "No data available";
    }
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return "Unable to serialize data to JSON";
    }
  }, [data]);

  return (
    <div className={`raw-json-view ${theme}`}>
      <pre>{jsonString}</pre>
    </div>
  );
}