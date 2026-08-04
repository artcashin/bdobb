import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const mockOpenUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mockOpenUrl }));

// The Rust preflight. Defaults to "frameable" so existing tests are unaffected.
const mockInvoke = vi.hoisted(() =>
  vi.fn(async () => ({ frameable: true, reason: "" }))
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../lib/logger", () => ({ logError: vi.fn() }));

import IframeRenderer from "./IframeRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

describe("IframeRenderer", () => {
  it("renders iframe with URL", () => {
    const url = "https://example.com/widget";

    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "iframe",
      endpoint: url,
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

    render(<IframeRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    const iframe = document.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe?.getAttribute("src")).toBe(url);
  });

  it("applies sandbox attributes", () => {
    const url = "https://example.com/widget";

    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
      subCategory: null,
      type: "iframe",
      endpoint: url,
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

    render(<IframeRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-forms");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-popups");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-same-origin");
  });

  it("handles error state", () => {
    const widgetDef = {
      id: "test-widget",
      name: "Test Widget",
      description: "",
      category: "Test",
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

    render(<IframeRenderer data={null} widgetDef={widgetDef} theme="dark" />);

    expect(screen.getByText("Invalid iframe URL")).toBeInTheDocument();
  });

  describe("as the Website built-in", () => {
    const def = makeWidgetDef({ name: "Website", type: "iframe", endpoint: "" });

    it("frames the src override rather than the widget endpoint", () => {
      render(
        <IframeRenderer
          data={null}
          widgetDef={makeWidgetDef({ name: "Website", type: "iframe", endpoint: "https://from-widgets-json.example" })}
          theme="dark"
          src="https://typed-by-the-user.example/page"
        />
      );
      expect(screen.getByTitle("Website")).toHaveAttribute(
        "src",
        "https://typed-by-the-user.example/page"
      );
    });

    it("prompts for a URL instead of showing an error when none is set", () => {
      // A card just dragged onto the grid has no URL yet; that is a normal
      // state, not a failure to report in red.
      render(
        <IframeRenderer data={null} widgetDef={def} theme="dark" src="" emptyHint="Set a URL" />
      );
      expect(screen.getByText("Set a URL")).toBeInTheDocument();
      expect(screen.queryByText(/Invalid/)).not.toBeInTheDocument();
    });

    it("rejects a hostile scheme typed into the URL field", () => {
      // The user types this one, so it is as untrusted as widgets.json.
      render(
        <IframeRenderer
          data={null}
          widgetDef={def}
          theme="dark"
          src="javascript:alert(1)"
          emptyHint="Set a URL"
        />
      );
      expect(screen.getByText(/Invalid iframe URL/)).toBeInTheDocument();
      expect(document.querySelector("iframe")).toBeNull();
    });

    it("does not grant the frame allow-same-origin", () => {
      // With it, the framed document gets its own origin's storage and
      // credentials inside our webview — not a trade worth making for a widget
      // that can point anywhere.
      render(<IframeRenderer data={null} widgetDef={def} theme="dark" src="https://example.com" />);
      const sandbox = screen.getByTitle("Website").getAttribute("sandbox") ?? "";
      expect(sandbox).not.toContain("allow-same-origin");
      expect(sandbox).toContain("allow-scripts");
    });

    it("offers an external escape hatch, since a refused frame is undetectable", () => {
      render(<IframeRenderer data={null} widgetDef={def} theme="dark" src="https://example.com/x" />);
      fireEvent.click(screen.getByText(/Open externally/));
      expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/x");
    });
  });

  describe("sites that refuse framing", () => {
    const def = makeWidgetDef({ name: "Website", type: "iframe", endpoint: "" });

    // The spies persist across tests in this file, so an assertion on "was
    // called with" would otherwise match a click from an earlier case.
    beforeEach(() => {
      mockOpenUrl.mockClear();
      mockInvoke.mockClear();
    });

    it("replaces the frame with an explanation, centred", async () => {
      // A refused frame fires load and reports a null document exactly like an
      // allowed one, so without the preflight this renders as a blank card and
      // the user has to guess why.
      mockInvoke.mockResolvedValueOnce({
        frameable: false,
        reason: "X-Frame-Options: SAMEORIGIN",
      });
      render(
        <IframeRenderer data={null} widgetDef={def} theme="dark" src="https://www.google.com" />
      );

      expect(await screen.findByText(/refuses to be embedded/i)).toBeInTheDocument();
      expect(screen.getByText("www.google.com")).toBeInTheDocument();
      expect(screen.getByText("X-Frame-Options: SAMEORIGIN")).toBeInTheDocument();
      // No point rendering a frame that cannot load.
      expect(document.querySelector("iframe")).toBeNull();
    });

    it("still offers the way out", async () => {
      mockInvoke.mockResolvedValueOnce({ frameable: false, reason: "X-Frame-Options: DENY" });
      render(
        <IframeRenderer data={null} widgetDef={def} theme="dark" src="https://www.google.com" />
      );
      // Wait for the refusal UI to settle, then query the button live. The
      // element findByText resolves with is detached by the re-render that
      // follows, so clicking it reaches no handler.
      await screen.findByText(/refuses to be embedded/i);
      fireEvent.click(screen.getByRole("button", { name: /Open externally/ }));
      expect(mockOpenUrl).toHaveBeenCalledWith("https://www.google.com/");
    });

    it("frames normally when the site permits it", async () => {
      mockInvoke.mockResolvedValueOnce({ frameable: true, reason: "" });
      render(
        <IframeRenderer data={null} widgetDef={def} theme="dark" src="https://example.com" />
      );
      expect(screen.getByTitle("Website")).toBeInTheDocument();
      expect(screen.queryByText(/refuses to be embedded/i)).not.toBeInTheDocument();
    });

    it("frames anyway when the preflight itself fails", async () => {
      // A site that is down, or blocks HEAD, is not the same as one that
      // refuses framing — treating it as refusal would hide working pages.
      mockInvoke.mockRejectedValueOnce(new Error("network unreachable"));
      render(
        <IframeRenderer data={null} widgetDef={def} theme="dark" src="https://maybe.example" />
      );
      expect(screen.getByTitle("Website")).toBeInTheDocument();
    });
  });
});