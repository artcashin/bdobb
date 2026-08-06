import { useEffect, useRef, useState } from "react";
import type { WidgetDef } from "../../lib/types";
import { WidgetParams } from "../../lib/types";

interface SymphonyRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
  params: WidgetParams;
}

export default function SymphonyRenderer({
  params,
}: SymphonyRendererProps) {
  const { pod, id, pid } = params;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof IntersectionObserver === "undefined") {
      return true;
    }
    return false;
  });

  const url = `https://${pod}/embed/index.html?streamId=${id}&partnerId=${pid}&mode=dark&condensed=true`;

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

  if (!url || !pod || !id || !pid) {
    return <div className="renderer-error">Invalid Symphony URL</div>;
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
