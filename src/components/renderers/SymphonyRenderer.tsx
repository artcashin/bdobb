import { useEffect, useRef, useState } from "react";

/**
 * The five values a Symphony embed needs. Declared once, here, and
 * destructured in full below — a prior attempt at this integration drifted
 * between the type, this component, and its call site, and was rolled back
 * for it.
 *
 * `partnerId` is sent verbatim. It is an app-level setting that does not
 * exist yet (Task 5 adds it and wires the real value into the call site);
 * until then callers pass "" and this component does not second-guess that.
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
  const { pod, id, partnerId, mode, theme } = params;
  const configured = pod.trim() !== "" && id.trim() !== "";
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

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

  if (!configured) {
    // Not configured yet — a normal state for a freshly dropped card, not an
    // error. Framing "https:///embed/..." would just show blank.
    return (
      <div className="renderer-empty">Set a pod and stream ID to open Symphony.</div>
    );
  }

  return (
    <div className="symphony-container" ref={containerRef}>
      {visible && (
        <iframe
          src={buildEmbedUrl({ pod, id, partnerId, mode, theme })}
          // allow-same-origin is required here, unlike the general-purpose
          // Website iframe: Symphony's embed SDK needs its own origin's
          // storage to maintain the chat session.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          className="symphony-widget"
          title="Symphony"
        />
      )}
    </div>
  );
}
