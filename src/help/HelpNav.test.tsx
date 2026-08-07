import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpNav from "./HelpNav";

describe("HelpNav", () => {
  const nav = {
    Widgets: [
      { slug: "news-ticker", title: "News Ticker" },
      { slug: "ai-chat", title: "AI Chat" },
    ],
  };

  it("renders each category and its pages", () => {
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={() => {}} />);
    expect(screen.getByText("Widgets")).toBeInTheDocument();
    expect(screen.getByText("News Ticker")).toBeInTheDocument();
    expect(screen.getByText("AI Chat")).toBeInTheDocument();
  });

  it("calls onSelect with the page's slug when clicked", () => {
    const onSelect = vi.fn();
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("AI Chat"));
    expect(onSelect).toHaveBeenCalledWith("ai-chat");
  });

  it("marks the active page", () => {
    render(<HelpNav nav={nav} activeSlug="news-ticker" onSelect={() => {}} />);
    expect(screen.getByText("News Ticker").closest("button")).toHaveClass("active");
  });
});
