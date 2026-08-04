import type { WidgetDef } from "../../lib/types";
import { logOnce } from "../../lib/logger";

interface UnsupportedRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function UnsupportedRenderer({ widgetDef, theme }: UnsupportedRendererProps) {
  // One log line per widget type, not per render -- a dashboard with several
  // unsupported cards of the same type would otherwise spam the log on every
  // re-render.
  logOnce(
    `widget-type-${widgetDef.type}`,
    `Widget type "${widgetDef.type}" is not supported in this version`
  );
  return (
    <div className={`unsupported-container ${theme}`}>
      <div className="unsupported-card">
        <h3>Unsupported in v1</h3>
        <p>
          The {widgetDef.type} widget type is not supported in this version.
        </p>
      </div>
    </div>
  );
}