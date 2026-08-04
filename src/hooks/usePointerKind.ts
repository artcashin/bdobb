import { useEffect, useState } from "react";

export type PointerKind = "fine" | "coarse";

/**
 * Whether a precise pointing device is driving the app.
 *
 * This exists because of iPadOS. The rail and the chat pane are hover panels —
 * mouse-enter opens them, mouse-leave starts a collapse timer — which works on
 * a desktop and works on an iPad with a trackpad or mouse, since iPadOS
 * delivers real pointer events for those. It does not work under touch: the
 * webview synthesises an enter on first tap and never a leave, so a panel opens
 * and stays open.
 *
 * Read reactively rather than once at startup: a Magic Keyboard can be attached
 * or removed while the app is running, and the same iPad flips between the two
 * paradigms when that happens.
 *
 * `(pointer: fine)` describes the *primary* input. An iPad with a trackpad
 * attached reports fine; the same iPad held in the hand reports coarse.
 */
export function usePointerKind(): PointerKind {
  const [kind, setKind] = useState<PointerKind>(() => detect());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(pointer: fine)");
    const onChange = () => setKind(mq.matches ? "fine" : "coarse");

    // addEventListener on MediaQueryList is the modern form; Safari only gained
    // it in 14, and the app targets iPadOS 16+, so no addListener fallback.
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return kind;
}

function detect(): PointerKind {
  // Server-side and jsdom have no matchMedia. A desktop assumption is the right
  // default: it keeps every existing test and the desktop build on the path
  // they were already on.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "fine";
  return window.matchMedia("(pointer: fine)").matches ? "fine" : "coarse";
}
