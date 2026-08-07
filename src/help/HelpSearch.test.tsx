import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import HelpSearch from "./HelpSearch";

// vi.mock factories are hoisted above other code in this file, so the mock
// search fn needs vi.hoisted to be referenceable both here and inside tests
// (to assert on the args it was called with).
const searchIndexMock = vi.hoisted(() => {
  const mockResults = [{ id: "news-ticker", title: "News Ticker", slug: "news-ticker" }];
  return { search: vi.fn(() => mockResults) };
});

vi.mock("./loadContent", () => ({
  loadSearchIndex: () => searchIndexMock,
}));

describe("HelpSearch", () => {
  beforeEach(() => {
    searchIndexMock.search.mockClear();
  });

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

  it("searches with prefix and fuzzy matching enabled so partial/typo queries return results", () => {
    render(<HelpSearch onSelect={() => {}} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "quote" } });
    expect(searchIndexMock.search).toHaveBeenCalledWith("quote", { prefix: true, fuzzy: 0.2 });
  });
});
