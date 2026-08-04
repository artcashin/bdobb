import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const openUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

const widgetDef = makeWidgetDef({ type: "markdown" });

describe("MarkdownRenderer", () => {
  it("renders markdown as HTML", () => {
    render(<MarkdownRenderer data={"# Title\n\nBody text"} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("Body text")).toBeInTheDocument();
  });

  it("renders code blocks", () => {
    render(
      <MarkdownRenderer data={"```\nconst x = 1;\n```"} widgetDef={widgetDef} theme="dark" />
    );
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });

  it("does not render raw HTML embedded in the markdown", () => {
    // react-markdown without rehype-raw must treat this as text, not markup.
    render(
      <MarkdownRenderer data={"<img src=x onerror=alert(1)>"} widgetDef={widgetDef} theme="dark" />
    );
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows an empty state when there is no content", () => {
    render(<MarkdownRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/No markdown content available/i)).toBeInTheDocument();
  });

  it("falls back to raw JSON when the endpoint returned non-text", () => {
    render(<MarkdownRenderer data={{ detail: "boom" }} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  describe("external links", () => {
    beforeEach(() => {
      openUrl.mockClear();
    });
    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    });

    it("opens external links via the opener plugin and blocks in-app navigation under Tauri", async () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      render(
        <MarkdownRenderer
          data="[example](https://example.com)"
          widgetDef={widgetDef}
          theme="dark"
        />
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
        <MarkdownRenderer
          data="[example](https://example.com)"
          widgetDef={widgetDef}
          theme="dark"
        />
      );
      const link = screen.getByRole("link", { name: "example" });
      const notCancelled = fireEvent.click(link);
      expect(notCancelled).toBe(true); // preventDefault() was NOT called
      expect(openUrl).not.toHaveBeenCalled();
    });
  });
});
