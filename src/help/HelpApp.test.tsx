import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpApp from "./HelpApp";

vi.mock("./loadContent", () => ({
  loadNav: () => ({
    Widgets: [
      { slug: "news-ticker", title: "News Ticker" },
      { slug: "ai-chat", title: "AI Chat" },
    ],
  }),
  loadPage: (slug: string) => `# ${slug === "news-ticker" ? "News Ticker" : "AI Chat"}\n\nBody.`,
  loadSearchIndex: () => ({ search: () => [] }),
}));

describe("HelpApp", () => {
  it("shows the first nav page by default", () => {
    render(<HelpApp />);
    expect(screen.getByRole("heading", { name: "News Ticker" })).toBeInTheDocument();
  });

  it("navigates when a sidebar item is clicked", () => {
    render(<HelpApp />);
    fireEvent.click(screen.getByText("AI Chat"));
    expect(screen.getByRole("heading", { name: "AI Chat" })).toBeInTheDocument();
  });
});
