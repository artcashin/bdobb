import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpContent from "./HelpContent";

vi.mock("./loadContent", () => ({
  loadPage: (slug: string) =>
    slug === "news-ticker"
      ? "# News Ticker\n\nSee [Live Quotes](help://live-quotes) for the tape."
      : "# Live Quotes\n\nThe tape.",
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
});
