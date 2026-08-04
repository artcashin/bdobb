import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import HtmlRenderer from "./HtmlRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const widgetDef = makeWidgetDef({ type: "html", name: "HTML Widget" });

describe("HtmlRenderer", () => {
  it("renders server HTML in a sandboxed iframe", () => {
    render(<HtmlRenderer data="<p>hello</p>" widgetDef={widgetDef} theme="dark" />);
    const iframe = document.querySelector("iframe")!;
    expect(iframe.getAttribute("srcdoc")).toBe("<p>hello</p>");
  });

  it("enables scripts but withholds allow-same-origin", () => {
    // JS is required by the spec, but the frame must stay in an opaque origin
    // so backend-authored HTML cannot reach app storage or the parent.
    render(<HtmlRenderer data="<p>hi</p>" widgetDef={widgetDef} theme="dark" />);
    const sandbox = document.querySelector("iframe")!.getAttribute("sandbox")!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("shows an empty state when there is no content", () => {
    render(<HtmlRenderer data={null} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/No HTML content available/i)).toBeInTheDocument();
  });

  it("falls back to raw JSON when the endpoint returned non-text", () => {
    render(<HtmlRenderer data={{ detail: "boom" }} widgetDef={widgetDef} theme="dark" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });
});
