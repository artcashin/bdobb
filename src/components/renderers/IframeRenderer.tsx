import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WidgetDef } from "../../lib/types";
import { safeUrl } from "../../lib/safeUrl";
import { logError } from "../../lib/logger";

interface IframeRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
  /**
   * Overrides the widget's endpoint. The Website built-in takes its address
   * from a card parameter the user typed rather than from widgets.json; the
   * validation and sandboxing below are identical either way, so the two share
   * one renderer instead of a near-duplicate.
   */
  src?: string;
  /** Shown instead of "no URL" wording when the user has not entered one yet. */
  emptyHint?: string;
}

export default function IframeRenderer({
  widgetDef,
  theme,
  src,
  emptyHint,
}: IframeRendererProps) {
  const raw = src ?? widgetDef.endpoint;

  // The address comes either from a backend's widgets.json or from a field the
  // user typed — neither is trustworthy. The emptiness check this replaced let
  // any scheme through, including javascript:, and the sandbox attribute does
  // not help: it constrains what the framed document may do, not whether the
  // scheme runs.
  // Whether the site permits framing. Undetectable in the webview — a refused
  // frame fires `load` and reports a null document exactly like an allowed one —
  // so a Rust-side preflight reads the headers instead. null while unknown.
  const [refusal, setRefusal] = useState<string | null>(null);
  const url = safeUrl(raw);

  useEffect(() => {
    setRefusal(null);
    if (!url) return;
    let cancelled = false;
    invoke<{ frameable: boolean; reason: string }>("check_frameable", { url })
      .then((r) => {
        if (!cancelled && !r.frameable) setRefusal(r.reason);
      })
      // A failed preflight is not evidence of refusal — the site may be down, or
      // blocking HEAD. Fall through and let the frame try.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!url) {
    // An address not yet entered is a normal state for the built-in, not an
    // error to report in red.
    if (!raw?.trim() && emptyHint) {
      return <div className="renderer-empty">{emptyHint}</div>;
    }
    return <div className="renderer-error">Invalid iframe URL</div>;
  }

  if (refusal) {
    return (
      <div className={`iframe-container ${theme}`}>
        <div className="iframe-refused">
          <strong>This site refuses to be embedded.</strong>
          <span className="iframe-refused-host">{new URL(url).hostname}</span>
          <span className="iframe-refused-reason">{refusal}</span>
          <button
            type="button"
            className="iframe-external"
            onClick={() => {
              openUrl(url).catch((e) => logError(`openUrl failed for ${url}: ${String(e)}`));
            }}
          >
            Open externally ↗
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`iframe-container ${theme}`}>
      <iframe
        src={url}
        // allow-same-origin is deliberately absent. Many sites need it and will
        // render degraded or blank without it, but granting it hands the framed
        // document its own origin's storage and credentials inside our webview,
        // which is not a trade worth making for a widget that can point
        // anywhere.
        sandbox="allow-scripts allow-forms allow-popups"
        className="iframe-widget"
        title={widgetDef.name}
      />
      {/* Sites that send X-Frame-Options or frame-ancestors refuse to load, and
          a cross-origin frame gives no error event to detect it — the card just
          stays blank. Since the blockage cannot be observed, the explanation has
          to be present unconditionally rather than shown on failure. */}
      <div className="iframe-footer">
        <span className="iframe-hint">
          Blank? The site may refuse to be embedded.
        </span>
        <button
          type="button"
          className="iframe-external"
          title="Open in your browser"
          onClick={() => {
            openUrl(url).catch((e) => logError(`openUrl failed for ${url}: ${String(e)}`));
          }}
        >
          Open externally ↗
        </button>
      </div>
    </div>
  );
}
