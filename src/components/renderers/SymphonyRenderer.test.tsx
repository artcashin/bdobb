import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeWidgetDef } from "../../test/widgetDef";
import SymphonyRenderer from "./SymphonyRenderer";

describe("SymphonyRenderer", () => {
  it("renders iframe with Symphony URL", () => {
    const widgetDef = {
      id: "test-symphony",
      name: "Symphony Widget",
      description: "",
      category: "Symphony",
      subCategory: null,
      type: "iframe",
      endpoint: "",
      gridData: { w: 40, h: 15 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    };

    const props = {
      pod: "example.pod.symphony.com",
      id: "stream123",
      pid: "partner456",
    };

    const { container } = render(
      <SymphonyRenderer
        data={null}
        widgetDef={widgetDef}
        theme="dark"
        params={props}
      />
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe?.getAttribute("src")).toBe(
      "https://example.pod.symphony.com/embed/index.html?streamId=stream123&partnerId=partner456&mode=dark&condensed=true"
    );
  });

  it("applies sandbox policy", () => {
    const widgetDef = makeWidgetDef({ type: "iframe" });

    render(
      <SymphonyRenderer
        data={null}
        widgetDef={widgetDef}
        theme="dark"
        params={{ pod: "test.pod.com", id: "stream1", pid: "pid1" }}
      />
    );

    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups"
    );
  });

  it("handles missing params gracefully", () => {
    const widgetDef = makeWidgetDef({ type: "iframe" });

    render(
      <SymphonyRenderer
        data={null}
        widgetDef={widgetDef}
        theme="dark"
        params={{ pod: "", id: "", pid: "" }}
      />
    );

    expect(screen.getByText(/Invalid Symphony URL/i)).toBeInTheDocument();
  });
});
