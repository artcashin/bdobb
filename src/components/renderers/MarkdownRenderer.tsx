import ReactMarkdown, { type Components } from "react-markdown";
import type { WidgetDef } from "../../lib/types";
import { logError } from "../../lib/logger";
import RawJsonView from "./RawJsonView";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Backend-supplied markdown can contain external links. A bare `<a href>`
// would navigate the whole app's webview away to the remote page, with no
// browser chrome to get back. Open external links via the opener plugin's
// system browser instead -- but only under Tauri: this app is also opened in
// a plain browser for layout checks, where `@tauri-apps/plugin-opener`'s IPC
// call would throw, so the click must fall through to ordinary browser
// navigation there instead.
const ExternalLink: Components["a"] = ({ href, children, ...rest }) => {
  const handleClick = (): void => {
    if (!href || !isTauri()) return;
    import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(href))
      .catch((e) => logError(`failed to open external link ${href}: ${String(e)}`));
  };
  return (
    <a
      href={href}
      onClick={(e) => {
        if (href && isTauri()) e.preventDefault();
        handleClick();
      }}
      {...rest}
    >
      {children}
    </a>
  );
};

interface MarkdownRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function MarkdownRenderer({ data, widgetDef, theme }: MarkdownRendererProps) {
  if (data === null || data === undefined || data === "") {
    return <div className="renderer-empty">No markdown content available</div>;
  }

  // The endpoint returned something other than text — show it rather than
  // rendering an empty frame.
  if (typeof data !== "string") {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  return (
    <div className={`markdown-container ${theme}`}>
      <ReactMarkdown components={{ a: ExternalLink }}>{data}</ReactMarkdown>
    </div>
  );
}