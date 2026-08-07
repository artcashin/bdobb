import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpApp from "./HelpApp";
import type { NavTree } from "./loadContent";

const pageTitles: Record<string, string> = {
  home: "Home",
  "news-ticker": "News Ticker",
  "ai-chat": "AI Chat",
};

const { loadNav } = vi.hoisted(() => ({
  loadNav: vi.fn(
    (): NavTree => ({
      Home: [{ slug: "home", title: "Home" }],
      Widgets: [
        { slug: "news-ticker", title: "News Ticker" },
        { slug: "ai-chat", title: "AI Chat" },
      ],
    }),
  ),
}));

vi.mock("./loadContent", () => ({
  loadNav: () => loadNav(),
  loadPage: (slug: string) => `# ${pageTitles[slug] ?? slug}\n\nBody.`,
  loadSearchIndex: () => ({ search: () => [] }),
}));

describe("HelpApp", () => {
  it("shows the home page by default, not the first category's first page", () => {
    render(<HelpApp />);
    // The "Home" nav category label is also an <h3>, so this must be
    // scoped to the page's <h1> to avoid matching both.
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });

  it("navigates when a sidebar item is clicked", () => {
    render(<HelpApp />);
    fireEvent.click(screen.getByText("AI Chat"));
    expect(screen.getByRole("heading", { name: "AI Chat" })).toBeInTheDocument();
  });
});

describe("HelpApp with no Home category", () => {
  it("falls back to the first available page instead of a slug that doesn't exist", () => {
    loadNav.mockReturnValueOnce({
      Widgets: [{ slug: "news-ticker", title: "News Ticker" }],
    });
    render(<HelpApp />);
    expect(screen.getByRole("heading", { level: 1, name: "News Ticker" })).toBeInTheDocument();
  });
});
