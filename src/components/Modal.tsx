import { ReactNode, useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Everything that can hold focus inside the dialog, in document order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Modal({ isOpen, onClose, title, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Whatever had focus when the dialog opened, so it can be handed back.
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  // Tracks whether the mousedown that started the current click sequence
  // landed on the backdrop itself, as opposed to bubbling up from a child --
  // selecting text inside the dialog and releasing the mouse over the
  // backdrop must not close it (desk dc4664b).
  const mouseDownOnBackdrop = useRef(false);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    mouseDownOnBackdrop.current = e.target === e.currentTarget;
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && mouseDownOnBackdrop.current) {
      onClose();
    }
  };

  const focusables = useCallback((): HTMLElement[] => {
    const root = dialogRef.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  }, []);

  // Move focus into the dialog on open and return it on close. Without this the
  // keyboard stayed on the page behind: a screen reader announced the dialog
  // while Tab still walked the dashboard underneath it.
  useEffect(() => {
    if (!isOpen) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const first = focusables()[0] ?? dialogRef.current;
    first?.focus();

    return () => {
      restoreRef.current?.focus?.();
    };
  }, [isOpen, focusables]);

  // Escape closes, and Tab cycles within the dialog. A dialog that traps
  // neither is one a keyboard user cannot leave without a mouse.
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only Escape needs the repeat guard (holding it down must not fire
        // onClose over and over); Tab must keep trapping focus on every
        // repeat too, or holding Tab down walks focus straight out of the
        // dialog, defeating the trap (desk dc4664b).
        if (e.repeat) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped the dialog
      // entirely (portalled content sits outside the React tree, so browsers
      // will happily tab past it into the page behind).
      if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose, focusables]);

  if (!isOpen) return null;

  const modalContent = (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        // Names the dialog for assistive tech; aria-modal alone left it
        // announced as an unlabelled group.
        aria-labelledby={titleId}
        tabIndex={-1}
        className="modal-content"
      >
        <div className="modal-header">
          <h2 className="modal-title" id={titleId}>{title}</h2>
          <button
            onClick={onClose}
            className="modal-close-btn"
            aria-label="Close modal"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="modal-close-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        <div className="modal-body">{children}</div>

        {footer && (
          <div className="modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return typeof window !== "undefined"
    ? createPortal(modalContent, document.body)
    : null;
}

export default Modal;
