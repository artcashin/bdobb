import { useCallback, useEffect, useRef, useState } from "react";

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
}

export function useHoverPanel({
  collapseDelayMs, sticky,
}: HoverPanelOptions): HoverPanel {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inside = useRef(false);
  const stickyRef = useRef(sticky);

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

  return { expanded, onMouseEnter, onMouseLeave, open, close };
}
