import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { logError } from "../../lib/logger";

/**
 * The five values a Symphony embed needs. Declared once, here, and
 * destructured in full below — a prior attempt at this integration drifted
 * between the type, this component, and its call site, and was rolled back
 * for it.
 *
 * `partnerId` is sent verbatim. WidgetCard passes it from
 * `settings.symphonyPartnerId` (empty string when unset); this component
 * does not second-guess that value.
 */
export interface SymphonyParams {
  pod: string;
  id: string;
  partnerId: string;
  mode: string;
  theme: string;
}

interface SymphonyRendererProps {
  params: SymphonyParams;
}

/** https://{pod}/embed/index.html?streamId={id}&partnerId={partnerId}&mode={mode}&theme={theme}&condensed=true */
function buildEmbedUrl({ pod, id, partnerId, mode, theme }: SymphonyParams): string {
  const query = new URLSearchParams();
  query.set("streamId", id);
  query.set("partnerId", partnerId);
  query.set("mode", mode);
  query.set("theme", theme);
  query.set("condensed", "true");
  return `https://${pod}/embed/index.html?${query.toString()}`;
}

/**
 * Symphony's embedded chat client, framed in a dashboard card.
 *
 * The iframe is not created until the card's container scrolls into view —
 * Symphony's embed opens a live connection as soon as it loads, and a
 * dashboard can hold cards that are never scrolled to. Once created it stays
 * mounted; going off-screen again must not tear down a live chat session.
 */
export default function SymphonyRenderer({ params }: SymphonyRendererProps) {
  const { pod, id } = params;
  const configured = pod.trim() !== "" && id.trim() !== "";
  const embedUrl = configured ? buildEmbedUrl(params) : "";
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // Whether the pod permits framing. Undetectable from the webview — a
  // refused frame fires `load` and reports a null document exactly like an
  // allowed one — so a Rust-side preflight reads the headers instead. null
  // while unknown or not yet checked; the iframe renders optimistically in
  // that state and this swaps it out only if the check comes back negative.
  const [refusal, setRefusal] = useState<string | null>(null);
  // Whether the preflight positively confirmed the pod is frameable. Starts
  // false (and is reset to false whenever the check re-runs) so the escape
  // hatch below defaults to showing — it is only hidden once we have an
  // actual positive answer, not merely the absence of a refusal.
  const [frameable, setFrameable] = useState(false);

  useEffect(() => {
    // Unconfigured cards render the hint below instead of the container div,
    // so there is nothing to observe yet — and nothing must flip `visible`
    // early, or the card would skip straight past lazy-loading the moment it
    // does get configured. `configured` is a dependency precisely so this
    // effect gets another chance to run once the container div (and its ref)
    // exists.
    if (visible || !configured) return;
    const el = containerRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer support: render rather than never.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, configured]);

  useEffect(() => {
    // Nothing to check until the card is about to actually load the pod —
    // checking earlier would fire a network request for cards never scrolled
    // into view, which is exactly what the lazy-loading above exists to avoid.
    setRefusal(null);
    setFrameable(false);
    if (!visible || !embedUrl) return;
    let cancelled = false;
    invoke<{ frameable: boolean; reason: string }>("check_frame_options", {
      url: embedUrl,
    })
      .then((r) => {
        if (cancelled) return;
        if (!r.frameable) setRefusal(r.reason);
        else setFrameable(true);
      })
      // A failed preflight is not evidence of refusal — the pod may be down,
      // or blocking HEAD. Fall through and let the frame try, but the error
      // itself (scheme rejection, DNS failure, timeout) is worth keeping for
      // diagnosing a misconfigured or unreachable pod.
      .catch((e) => {
        if (!cancelled) {
          logError(`check_frame_options failed for ${embedUrl}: ${String(e)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, embedUrl]);

  if (!configured) {
    // Not configured yet — a normal state for a freshly dropped card, not an
    // error. Framing "https:///embed/..." would just show blank.
    return (
      <div className="renderer-empty">Set a pod and stream ID to open Symphony.</div>
    );
  }

  if (refusal) {
    return (
      <div className="symphony-container">
        <div className="iframe-refused">
          <strong>This pod refuses to be embedded.</strong>
          <span className="iframe-refused-host">{new URL(embedUrl).hostname}</span>
          <span className="iframe-refused-reason">{refusal}</span>
          <button
            type="button"
            className="iframe-external"
            onClick={() => {
              openUrl(embedUrl).catch((e) =>
                logError(`openUrl failed for ${embedUrl}: ${String(e)}`)
              );
            }}
          >
            Open externally ↗
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="symphony-container" ref={containerRef}>
      {visible && (
        <>
          <iframe
            src={embedUrl}
            // allow-same-origin is required here, unlike the general-purpose
            // Website iframe: Symphony's embed SDK needs its own origin's
            // storage to maintain the chat session.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            className="symphony-widget"
            title="Symphony"
          />
          {/* Unlike IframeRenderer's, this footer is conditional: unlike an
              arbitrary scrollable website, this card is a fixed-layout chat
              client where the bottom strip is the primary interaction
              target (the compose box), so it must not sit over a healthy
              pod. It only appears while the preflight has not positively
              confirmed the pod is frameable — i.e. still pending, errored,
              or blocked (preflight blocked, pod unreachable, VPN-gated)
              leave `refusal` null and the frame simply blank, with no
              cross-origin signal to detect it, so the explanation and the
              way out still need to be present in those cases. */}
          {!frameable && (
            <div className="iframe-footer">
              <span className="iframe-hint">
                Blank? The pod may refuse to be embedded.
              </span>
              <button
                type="button"
                className="iframe-external"
                title="Open in your browser"
                onClick={() => {
                  openUrl(embedUrl).catch((e) =>
                    logError(`openUrl failed for ${embedUrl}: ${String(e)}`)
                  );
                }}
              >
                Open externally ↗
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
