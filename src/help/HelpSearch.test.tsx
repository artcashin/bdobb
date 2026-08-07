import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpSearch from "./HelpSearch";

const mockResults = [{ id: "news-ticker", title: "News Ticker", slug: "news-ticker" }];

vi.mock("./loadContent", () => ({
  loadSearchIndex: () => ({
    search: vi.fn(() => mockResults),
  }),
}));

describe("HelpSearch", () => {
  it("shows matching results as you type", () => {
    render(<HelpSearch onSelect={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ticker" } });
    expect(screen.getByText("News Ticker")).toBeInTheDocument();
  });

  it("calls onSelect with the result's slug when clicked", () => {
    const onSelect = vi.fn();
    render(<HelpSearch onSelect={onSelect} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ticker" } });
    fireEvent.click(screen.getByText("News Ticker"));
    expect(onSelect).toHaveBeenCalledWith("news-ticker");
  });
});
