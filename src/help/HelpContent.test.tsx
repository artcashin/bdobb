import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpContent from "./HelpContent";

vi.mock("./loadContent", () => ({
  loadPage: (slug: string) =>
    slug === "news-ticker"
      ? "# News Ticker\n\n![A screenshot](./assets/news-window.png)\n\nSee [Live Quotes](help://live-quotes) for the tape."
      : slug === "unsafe-link"
        ? "# Unsafe Link\n\n[click me](javascript:alert(1))"
        : "# Live Quotes\n\nThe tape.",
  loadAssetUrl: (filename: string) => `/resolved/${filename}`,
}));

describe("HelpContent", () => {
  it("renders the page's markdown", () => {
    render(<HelpContent slug="news-ticker" onNavigate={() => {}} />);
    expect(screen.getByRole("heading", { name: "News Ticker" })).toBeInTheDocument();
  });

  it("intercepts help:// links and calls onNavigate instead of following them", () => {
    const onNavigate = vi.fn();
    render(<HelpContent slug="news-ticker" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Live Quotes"));
    expect(onNavigate).toHaveBeenCalledWith("live-quotes");
  });

  it("sanitizes non-help:// links with an unsafe scheme instead of passing them through", () => {
    render(<HelpContent slug="unsafe-link" onNavigate={() => {}} />);
    const link = screen.getByText("click me");
    expect(link).not.toHaveAttribute("href", "javascript:alert(1)");
    expect(link.getAttribute("href")).toBe("");
  });

  it("resolves bundled image references to their real served URL", () => {
    render(<HelpContent slug="news-ticker" onNavigate={() => {}} />);
    const img = screen.getByRole("img", { name: "A screenshot" });
    expect(img).toHaveAttribute("src", "/resolved/news-window.png");
  });
});
