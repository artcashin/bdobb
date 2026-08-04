import { useCallback, useEffect, useRef, useState } from "react";
import { usePointerKind } from "./usePointerKind";

export interface HoverPanelOptions {
  collapseDelayMs: number;
  /** while true the panel never auto-collapses (input focus, streaming, pinned) */
  sticky: boolean;
}

export interface HoverPanel {
  expanded: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  open: () => void;
  close: () => void;
  /**
   * Attach to the panel's root element. Under touch it makes a tap open the
   * panel; with a pointer it does nothing, because hover already has.
   */
  onPointerDown: (e: { pointerType?: string }) => void;
  /** Element ref the outside-tap detector uses to know what "outside" means. */
  ref: (el: HTMLElement | null) => void;
}

export function useHoverPanel({
  collapseDelayMs, sticky,
}: HoverPanelOptions): HoverPanel {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inside = useRef(false);
  const stickyRef = useRef(sticky);
  const rootRef = useRef<HTMLElement | null>(null);
  const pointerKind = usePointerKind();

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!inside.current && !stickyRef.current) setExpanded(false);
    }, collapseDelayMs);
  }, [cancel, collapseDelayMs]);

  useEffect(() => {
    stickyRef.current = sticky;
    // sticky released while the mouse is already gone -> start the collapse.
    // Guarded on `expanded` too: an already-collapsed panel (e.g. at mount)
    // has nothing to collapse, so don't schedule a pointless timer for it.
    if (!sticky && !inside.current && expanded) scheduleCollapse();
  }, [sticky, expanded, scheduleCollapse]);

  useEffect(() => cancel, [cancel]);

  const onMouseEnter = useCallback(() => {
    inside.current = true;
    cancel();
    setExpanded(true);
  }, [cancel]);

  const onMouseLeave = useCallback(() => {
    inside.current = false;
    scheduleCollapse();
  }, [scheduleCollapse]);

  const open = useCallback(() => {
    // Mirrors onMouseEnter: a programmatic open() means "treat this as if
    // the pointer is here" so a later sticky release doesn't schedule a
    // collapse out from under it before the user ever actually interacts.
    inside.current = true;
    cancel();
    setExpanded(true);
  }, [cancel]);

  const close = useCallback(() => {
    inside.current = false;
    cancel();
    setExpanded(false);
  }, [cancel]);

  /**
   * Touch: a tap on the panel opens it.
   *
   * Guarded on pointerType because iPadOS sends a synthetic mouse-enter for the
   * same tap. Without the guard the panel would open from the enter and then be
   * toggled again here, so a single tap would net to nothing.
   */
  const onPointerDown = useCallback(
    (e: { pointerType?: string }) => {
      if (e.pointerType === "mouse") return;
      inside.current = true;
      cancel();
      setExpanded(true);
    },
    [cancel]
  );

  /**
   * Touch: a tap anywhere outside the panel dismisses it.
   *
   * There is no mouse-leave under touch, so without this a panel opens and
   * stays open forever. "Outside" is anything not inside the panel's own
   * element — including a widget card, which is deliberate: on a full
   * dashboard there may be no bare background left to tap, and a dismiss that
   * only fired on true empty space could strand the panel open.
   *
   * pointerdown in the capture phase, so the dismissal is decided before the
   * tap reaches whatever is underneath.
   */
  useEffect(() => {
    if (pointerKind !== "coarse" || !expanded) return;

    const onDocPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      if (stickyRef.current) return;
      inside.current = false;
      setExpanded(false);
    };

    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [pointerKind, expanded]);

  const ref = useCallback((el: HTMLElement | null) => {
    rootRef.current = el;
  }, []);

  return { expanded, onMouseEnter, onMouseLeave, open, close, onPointerDown, ref };
}
