import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import HelpErrorBoundary from "./HelpErrorBoundary";

function Thrower(): never {
  throw new Error("No bundled help page for slug \"missing\"");
}

describe("HelpErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <HelpErrorBoundary>
        <div>All good</div>
      </HelpErrorBoundary>
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows a readable fallback instead of a blank window when a child throws", () => {
    // React logs the caught error to the console by default; keep the test
    // output clean since we're asserting on the fallback UI, not the log.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <HelpErrorBoundary>
        <Thrower />
      </HelpErrorBoundary>
    );

    expect(screen.getByText(/Help content unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/No bundled help page for slug "missing"/)).toBeInTheDocument();

    consoleError.mockRestore();
  });
});
