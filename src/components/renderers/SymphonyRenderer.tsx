import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { WidgetDef } from "../../lib/types";
import { logError } from "../../lib/logger";

interface SymphonyRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
  params: {
    pod: string;
    id: string;
    partnerId: string;
    mode: string;
    theme: string;
  };
}

export default function SymphonyRenderer({
  params,
}: SymphonyRendererProps) {
  const { pod, id, partnerId, mode, theme } = params;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof IntersectionObserver === "undefined") {
      return true;
    }
    return false;
  });

  const url = `https://${pod}/embed/index.html?streamId=${id}&partnerId=${partnerId}&mode=${mode}&condensed=true`;

  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setRefusal(null);
    if (!url || !pod || !id) return;
    let cancelled = false;
    invoke<{ frameable: boolean; reason: string }>("check_frameable", { url })
      .then((r) => {
        if (!cancelled && !r.frameable) setRefusal(r.reason);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url, pod, id]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(iframe);

    return () => {
      observer.disconnect();
    };
  }, []);

  if (!url || !pod || !id) {
    return <div className="renderer-error">Invalid Symphony URL</div>;
  }

  if (refusal) {
    return (
      <div className="iframe-container dark">
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
    <div className="iframe-container dark">
      <iframe
        ref={iframeRef}
        src={isVisible ? url : undefined}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        className="iframe-widget"
        title="Symphony Widget"
      />
    </div>
  );
}
