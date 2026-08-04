import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHoverPanel } from "./useHoverPanel";

describe("useHoverPanel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("expands immediately on mouse enter", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );

    expect(result.current.expanded).toBe(false);

    act(() => {
      result.current.onMouseEnter();
    });

    expect(result.current.expanded).toBe(true);
  });

  it("collapses only after the delay elapses", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );

    act(() => {
      result.current.onMouseEnter();
      result.current.onMouseLeave();
    });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(result.current.expanded).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(result.current.expanded).toBe(false);
  });

  it("cancels the collapse when the mouse re-enters within the delay", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );

    act(() => {
      result.current.onMouseEnter();
      result.current.onMouseLeave();
    });

    vi.advanceTimersByTime(150);

    act(() => {
      result.current.onMouseEnter();
    });

    vi.advanceTimersByTime(1000);

    expect(result.current.expanded).toBe(true);
  });

  it("stays open while sticky (focused input / streaming), regardless of mouse", () => {
    const { result, rerender } = renderHook(
      ({ sticky }) => useHoverPanel({ collapseDelayMs: 300, sticky }),
      { initialProps: { sticky: true } }
    );

    act(() => {
      result.current.onMouseEnter();
      result.current.onMouseLeave();
    });

    vi.advanceTimersByTime(1000);

    expect(result.current.expanded).toBe(true);

    // sticky released with mouse outside -> collapses after the delay
    rerender({ sticky: false });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.expanded).toBe(false);
  });

  it("open() and close() are immediate", () => {
    const { result } = renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );

    act(() => {
      result.current.open();
    });

    expect(result.current.expanded).toBe(true);

    act(() => {
      result.current.close();
    });

    expect(result.current.expanded).toBe(false);
  });

  it("open() marks the pointer as inside, so a later sticky release does not collapse it", () => {
    const { result, rerender } = renderHook(
      ({ sticky }) => useHoverPanel({ collapseDelayMs: 300, sticky }),
      { initialProps: { sticky: true } }
    );

    act(() => {
      result.current.open();
    });

    expect(result.current.expanded).toBe(true);

    // sticky released, but the mouse was never actually inside/outside via
    // onMouseEnter/onMouseLeave -- open() must be treated as "still here".
    rerender({ sticky: false });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.expanded).toBe(true);
  });

  it("does not schedule a collapse timer on mount when already collapsed", () => {
    renderHook(() =>
      useHoverPanel({ collapseDelayMs: 300, sticky: false })
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
