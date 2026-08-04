// Ported from desk's src/components/renderers/renderers.test.tsx. Desk's
// renderers take narrow single-purpose props (html/src/markdown/metric/type);
// qwen's take a uniform {data, widgetDef, theme} contract (see
// docs/MERGE-NOTES.md, "Task 13"). This file keeps desk's regression intent
// -- especially the exact sandbox pins, which guard against silently
// widening a sandbox attribute -- rewritten against qwen's actual component
// APIs rather than copied verbatim.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWidgetDef } from "../../test/widgetDef";

vi.mock("../../lib/logger", () => ({
  logError: vi.fn(), logInfo: vi.fn(), logOnce: vi.fn(),
}));

const openUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

// IframeRenderer's Rust frameability preflight. Default to frameable so this
// file's assertions are about sandboxing/src, not the refusal UI (that has
// its own thorough coverage in IframeRenderer.test.tsx).
const mockInvoke = vi.hoisted(() =>
  vi.fn(async () => ({ frameable: true, reason: "" }))
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import HtmlRenderer from "./HtmlRenderer";
import IframeRenderer from "./IframeRenderer";
import MarkdownRenderer from "./MarkdownRenderer";
import MetricRenderer from "./MetricRenderer";
import UnsupportedRenderer from "./UnsupportedRenderer";

describe("HtmlRenderer", () => {
  it("renders srcdoc iframe with JS enabled but not same-origin", () => {
    const widgetDef = makeWidgetDef({ type: "html" });
    render(<HtmlRenderer data="<b>hello</b>" widgetDef={widgetDef} theme="dark" />);
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toBe("<b>hello</b>");
    // Pinned exactly, not `toContain` -- a mutation that widens this to
    // `allow-top-navigation allow-popups-to-escape-sandbox` (letting
    // untrusted widget JS navigate the app away or pop an unsandboxed
    // window) must fail here.
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups"
    );
  });
});

describe("IframeRenderer", () => {
  it("uses the endpoint URL verbatim as src, sandboxed WITHOUT allow-same-origin", async () => {
    // Desk grants allow-same-origin here (a real remote origin needs its own
    // cookies/storage). qwen deliberately withholds it: the address can come
    // from widgets.json OR from a URL the user types into the Website
    // built-in, and granting it hands that origin's storage/credentials to
    // whatever the widget points at. Parents disagree on this attribute --
    // the stricter (qwen's) sandbox wins per the merge plan; see
    // docs/MERGE-NOTES.md.
    const url = "https://example.com/widget";
    const widgetDef = makeWidgetDef({ type: "iframe", endpoint: url });
    render(<IframeRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    const frame = await screen.findByTitle(widgetDef.name);
    expect(frame.getAttribute("src")).toBe(url);
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms allow-popups"
    );
  });
});

describe("MarkdownRenderer", () => {
  it("renders markdown to HTML", () => {
    const widgetDef = makeWidgetDef({ type: "markdown" });
    render(
      <MarkdownRenderer data={"# Title\n\nbody **bold**"} widgetDef={widgetDef} theme="dark" />
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
  });

  describe("external links (Finding 4)", () => {
    const widgetDef = makeWidgetDef({ type: "markdown" });

    beforeEach(() => {
      openUrl.mockClear();
    });
    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    it("opens external links via the opener plugin and blocks in-app navigation under Tauri", async () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      render(
        <MarkdownRenderer data="[example](https://example.com)" widgetDef={widgetDef} theme="dark" />
      );
      const link = screen.getByRole("link", { name: "example" });
      // fireEvent.click returns dispatchEvent's result: false iff
      // preventDefault() was called.
      const notCancelled = fireEvent.click(link);
      expect(notCancelled).toBe(false);
      await vi.waitFor(() =>
        expect(openUrl).toHaveBeenCalledWith("https://example.com")
      );
    });

    it("is a harmless no-op outside Tauri, leaving normal browser navigation alone", () => {
      render(
        <MarkdownRenderer data="[example](https://example.com)" widgetDef={widgetDef} theme="dark" />
      );
      const link = screen.getByRole("link", { name: "example" });
      const notCancelled = fireEvent.click(link);
      expect(notCancelled).toBe(true); // preventDefault() was NOT called
      expect(openUrl).not.toHaveBeenCalled();
    });
  });
});

describe("MetricRenderer", () => {
  // Contract differs from desk: a qwen metric widget's endpoint returns a
  // bare number formatted via widgetDef.columnsDefs (prefix/suffix/
  // decimalPlaces), not a {label, value, delta} object -- so there is no
  // isMetric guard or delta field to crash-proof here. The
  // guard-and-fall-back-to-RawJsonView behavior desk's isMetric added for its
  // object contract (Finding 1: never let a non-primitive reach a React
  // child) is already qwen's default for any non-numeric payload, exercised
  // fully in MetricRenderer.test.tsx.
  it("formats a numeric payload using columnsDefs prefix/suffix/decimalPlaces", () => {
    const widgetDef = makeWidgetDef({
      type: "metric",
      columnsDefs: [{ field: "v", prefix: "$", suffix: "M", decimalPlaces: 1 }] as any,
    });
    render(<MetricRenderer data={1234.56} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText("$1,234.6M")).toBeInTheDocument();
  });

  it("never reaches the DOM with a non-primitive payload -- falls back to RawJsonView instead of throwing", () => {
    const widgetDef = makeWidgetDef({ type: "metric" });
    render(<MetricRenderer data={{ delta: { pct: 3 } }} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/"pct": 3/)).toBeInTheDocument();
  });
});

describe("UnsupportedRenderer", () => {
  it("names the unsupported type", () => {
    const widgetDef = makeWidgetDef({ type: "pdf" });
    render(<UnsupportedRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    expect(
      screen.getByText(/pdf widget type is not supported in this version/)
    ).toBeInTheDocument();
  });
});
