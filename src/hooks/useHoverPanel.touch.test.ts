import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoverPanel } from "./useHoverPanel";

/** Drives (pointer: fine) so the hook can be put in either paradigm. */
function pointer(fine: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    get matches() {
      return fine;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mq));
}

/** A pointerdown as the document listener will see it. */
function tap(target: Node, pointerType = "touch") {
  const e = new Event("pointerdown", { bubbles: true }) as PointerEvent & {
    pointerType: string;
  };
  Object.defineProperty(e, "pointerType", { value: pointerType });
  Object.defineProperty(e, "target", { value: target });
  document.dispatchEvent(e);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useHoverPanel under touch", () => {
  function setup(sticky = false) {
    pointer(false);
    const panelEl = document.createElement("div");
    const outsideEl = document.createElement("div");
    document.body.append(panelEl, outsideEl);

    const hook = renderHook(() => useHoverPanel({ collapseDelayMs: 300, sticky }));
    act(() => hook.result.current.ref(panelEl));
    return { hook, panelEl, outsideEl };
  }

  it("opens on a tap on the panel", () => {
    const { hook } = setup();
    expect(hook.result.current.expanded).toBe(false);
    act(() => hook.result.current.onPointerDown({ pointerType: "touch" }));
    expect(hook.result.current.expanded).toBe(true);
  });

  it("dismisses on a tap outside", () => {
    // There is no mouse-leave under touch, so without this the panel opens and
    // stays open forever.
    const { hook, outsideEl } = setup();
    act(() => hook.result.current.onPointerDown({ pointerType: "touch" }));
    expect(hook.result.current.expanded).toBe(true);

    act(() => tap(outsideEl));
    expect(hook.result.current.expanded).toBe(false);
  });

  it("stays open for a tap inside the panel", () => {
    const { hook, panelEl } = setup();
    act(() => hook.result.current.onPointerDown({ pointerType: "touch" }));

    const child = document.createElement("button");
    panelEl.appendChild(child);
    act(() => tap(child));
    expect(hook.result.current.expanded).toBe(true);
  });

  it("stays open while sticky, even on an outside tap", () => {
    // Sticky is chat-input focus: folding mid-sentence would lose the caret.
    const { hook, outsideEl } = setup(true);
    act(() => hook.result.current.onPointerDown({ pointerType: "touch" }));
    act(() => tap(outsideEl));
    expect(hook.result.current.expanded).toBe(true);
  });

  it("ignores the synthetic mouse event iPadOS sends for a tap", () => {
    // iPadOS raises a mouse-typed pointerdown alongside the touch one. Acting
    // on both would open from the first and toggle on the second, so a single
    // tap would net to nothing.
    const { hook } = setup();
    act(() => hook.result.current.onPointerDown({ pointerType: "mouse" }));
    expect(hook.result.current.expanded).toBe(false);
  });

  it("does not arm the outside-tap listener for a real pointer", () => {
    // With a mouse, mouse-leave already collapses the panel; a second
    // mechanism would close it on any click elsewhere in the app.
    pointer(true);
    const panelEl = document.createElement("div");
    const outsideEl = document.createElement("div");
    document.body.append(panelEl, outsideEl);

    const hook = renderHook(() => useHoverPanel({ collapseDelayMs: 300, sticky: false }));
    act(() => hook.result.current.ref(panelEl));
    act(() => hook.result.current.onMouseEnter());
    expect(hook.result.current.expanded).toBe(true);

    act(() => tap(outsideEl, "touch"));
    expect(hook.result.current.expanded).toBe(true);
  });
});
