import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));
import { logError } from "../lib/logger";

function Boom({ throws }: { throws: boolean }): React.ReactElement {
  if (throws) throw new Error("renderer exploded");
  return <div>content ok</div>;
}

// React logs caught render errors to console.error; silence it so a passing
// test does not print a stack trace.
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(logError).mockClear();
});
afterEach(() => consoleError.mockRestore());

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom throws={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText("content ok")).toBeInTheDocument();
  });

  it("contains a throw instead of unmounting the tree", () => {
    render(
      <div>
        <span>sibling survives</span>
        <ErrorBoundary label="Widget X">
          <Boom throws />
        </ErrorBoundary>
      </div>
    );
    // The whole point: the rest of the app is still on screen.
    expect(screen.getByText("sibling survives")).toBeInTheDocument();
    expect(screen.getByText(/Widget X failed to render/)).toBeInTheDocument();
    expect(screen.getByText("renderer exploded")).toBeInTheDocument();
    // Locks in the class name AppShell.errorBoundaries.test.tsx (desk
    // dc4664b) asserts on for every top-level pane/dialog boundary.
    expect(document.querySelector(".error-box")).toBeInTheDocument();
  });

  it("does not unmount a sibling boundary's tree when one boundary catches a throw " +
    "(desk dc4664b: independent regions, not just an unwrapped sibling)", () => {
    render(
      <>
        <ErrorBoundary label="Widget X">
          <Boom throws />
        </ErrorBoundary>
        <ErrorBoundary label="Widget Y">
          <div data-testid="sibling-ok">still here</div>
        </ErrorBoundary>
      </>
    );
    expect(document.querySelector(".error-box")).toBeInTheDocument();
    expect(screen.getByTestId("sibling-ok")).toBeInTheDocument();
  });

  it("routes the failure to the app log", () => {
    render(
      <ErrorBoundary label="Widget X">
        <Boom throws />
      </ErrorBoundary>
    );
    expect(vi.mocked(logError)).toHaveBeenCalled();
    expect(vi.mocked(logError).mock.calls[0][0]).toContain("renderer exploded");
  });

  it("renders a custom fallback when given one", () => {
    render(
      <ErrorBoundary fallback={(err) => <div>custom: {err.message}</div>}>
        <Boom throws />
      </ErrorBoundary>
    );
    expect(screen.getByText("custom: renderer exploded")).toBeInTheDocument();
  });

  it("recovers when resetKey changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey={1}>
        <Boom throws />
      </ErrorBoundary>
    );
    expect(screen.getByText(/Failed to render/)).toBeInTheDocument();

    // A card must recover on the next good fetch rather than staying broken
    // until it is remounted.
    rerender(
      <ErrorBoundary resetKey={2}>
        <Boom throws={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText("content ok")).toBeInTheDocument();
  });

  it("clicking the default fallback's Retry button resets the boundary and calls onRetry (desk dc4664b)", () => {
    const onRetry = vi.fn();
    let shouldThrow = true;
    function Flaky(): React.ReactElement {
      if (shouldThrow) throw new Error("still broken");
      return <div data-testid="recovered">back</div>;
    }
    const { rerender } = render(
      <ErrorBoundary onRetry={onRetry}>
        <Flaky />
      </ErrorBoundary>
    );
    expect(document.querySelector(".error-box")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ErrorBoundary onRetry={onRetry}>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByTestId("recovered")).toBeInTheDocument();
    expect(document.querySelector(".error-box")).not.toBeInTheDocument();
  });
});
