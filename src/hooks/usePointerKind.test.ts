import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePointerKind } from "./usePointerKind";

/** A controllable matchMedia so the attach/detach transition can be driven. */
function stubMatchMedia(initialFine: boolean) {
  const listeners = new Set<() => void>();
  let matches = initialFine;
  const mq = {
    get matches() {
      return matches;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mq));
  return {
    set(fine: boolean) {
      matches = fine;
      listeners.forEach((fn) => fn());
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("usePointerKind", () => {
  it("reports fine when a precise pointer is present", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => usePointerKind());
    expect(result.current).toBe("fine");
  });

  it("reports coarse for touch", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => usePointerKind());
    expect(result.current).toBe("coarse");
  });

  it("follows a pointer being attached or removed while running", () => {
    // The reason this is reactive: a Magic Keyboard can be docked or pulled off
    // mid-session, and the same iPad switches paradigm when it happens.
    const mm = stubMatchMedia(false);
    const { result } = renderHook(() => usePointerKind());
    expect(result.current).toBe("coarse");

    act(() => mm.set(true));
    expect(result.current).toBe("fine");

    act(() => mm.set(false));
    expect(result.current).toBe("coarse");
  });

  it("stops listening on unmount", () => {
    const mm = stubMatchMedia(true);
    const { unmount } = renderHook(() => usePointerKind());
    expect(mm.listenerCount()).toBe(1);
    unmount();
    expect(mm.listenerCount()).toBe(0);
  });

  it("assumes a desktop where matchMedia does not exist", () => {
    // jsdom and SSR have none; defaulting to fine keeps the desktop build and
    // every existing test on the path they were already on.
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(() => usePointerKind());
    expect(result.current).toBe("fine");
  });
});
