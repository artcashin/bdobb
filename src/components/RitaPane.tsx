import type { ReactNode } from "react";
import { useHoverPanel } from "../hooks/useHoverPanel";

export interface RitaPaneProps {
  pinned: boolean;
  /** true while the chat input has focus, so the pane cannot fold mid-sentence */
  sticky: boolean;
  /** an answer arrived while the pane was collapsed */
  unread?: boolean;
  onTogglePin(): void;
  children: ReactNode;
}

export default function RitaPane({
  pinned, sticky, unread = false, onTogglePin, children,
}: RitaPaneProps) {
  const panel = useHoverPanel({ collapseDelayMs: 300, sticky: pinned || sticky });
  const expanded = pinned || panel.expanded;

  return (
    <aside
      ref={panel.ref}
      className={`rita-pane ${expanded ? "expanded" : ""} ${pinned ? "pinned" : ""}`}
      onMouseEnter={panel.onMouseEnter}
      onMouseLeave={panel.onMouseLeave}
      onPointerDown={panel.onPointerDown}
      aria-label="Rita AI pane"
    >
      {expanded ? (
        <div className="rita-body">
          <div className="rita-header">
            <strong>Rita</strong>
            <button onClick={onTogglePin} title="Pin pane (Cmd/Ctrl+Shift+A)">
              {pinned ? "Unpin" : "Pin"}
            </button>
          </div>
          {children}
        </div>
      ) : (
        <div className="rita-tab">
          {unread && (
            <span
              className="rita-unread-dot"
              role="status"
              aria-label="New response from Rita"
            />
          )}
          Rita
        </div>
      )}
    </aside>
  );
}
