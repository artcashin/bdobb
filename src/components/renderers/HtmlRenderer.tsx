import type { WidgetDef } from "../../lib/types";
import RawJsonView from "./RawJsonView";

interface HtmlRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function HtmlRenderer({ data, widgetDef, theme }: HtmlRendererProps) {
  if (data === null || data === undefined || data === "") {
    return <div className="renderer-empty">No HTML content available</div>;
  }

  // The endpoint returned something other than text — show it rather than
  // rendering an empty frame.
  if (typeof data !== "string") {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  return (
    <div className={`html-container ${theme}`}>
      <iframe
        srcDoc={data}
        sandbox="allow-scripts allow-forms allow-popups"
        title={widgetDef.name}
        className="html-iframe"
      />
    </div>
  );
}