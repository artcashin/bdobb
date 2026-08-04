import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

describe("Modal", () => {
  const baseProps = {
    isOpen: true,
    onClose: () => {},
    title: "Test Modal",
    children: <div>Modal content</div>,
  };

  it("renders with all required props", () => {
    render(<Modal {...baseProps} />);
    expect(screen.getByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("renders footer when provided", () => {
    render(<Modal {...baseProps} footer={<button>OK</button>} />);
    expect(screen.getByRole("button", { name: "OK" })).toBeInTheDocument();
  });

  it("renders close button", () => {
    render(<Modal {...baseProps} />);
    const closeBtn = screen.getByRole("button", { name: "Close modal" });
    expect(closeBtn).toBeInTheDocument();
  });

  it("calls onClose when close button clicked", () => {
    const handleClose = vi.fn();
    render(<Modal {...baseProps} onClose={handleClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close modal" }));
    expect(handleClose).toHaveBeenCalled();
  });

  it("calls onClose when backdrop clicked", () => {
    const handleClose = vi.fn();
    render(<Modal {...baseProps} onClose={handleClose} />);
    const backdrop = screen.getByRole("dialog").parentElement;
    if (backdrop) {
      // A real click is a mousedown+mouseup(click) sequence on the same
      // element; the backdrop only closes when the mousedown that started
      // the sequence also landed there (desk dc4664b -- see the
      // "defense-in-depth" describe block below for the text-selection-drag
      // case this distinction exists for).
      fireEvent.mouseDown(backdrop);
      fireEvent.click(backdrop);
    }
    expect(handleClose).toHaveBeenCalled();
  });

  it("does not call onClose when content clicked", () => {
    const handleClose = vi.fn();
    render(<Modal {...baseProps} onClose={handleClose} />);
    fireEvent.click(screen.getByText("Modal content"));
    expect(handleClose).not.toHaveBeenCalled();
  });

  it("does not render when isOpen is false", () => {
    render(<Modal {...baseProps} isOpen={false} />);
    expect(screen.queryByText("Test Modal")).not.toBeInTheDocument();
  });

  it("renders modal footer when provided", () => {
    render(<Modal {...baseProps} footer={<button>OK</button>} />);
    expect(screen.getByText("OK")).toBeInTheDocument();
  });

  it("renders modal content in document body via portal", () => {
    render(<Modal {...baseProps} />);
    const modal = document.querySelector(".modal-backdrop");
    expect(modal).toBeInTheDocument();
  });
});

describe("Modal keyboard accessibility", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Settings">
        <button>Inside</button>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog on open", () => {
    render(
      <Modal isOpen onClose={() => {}} title="Settings">
        <button>Inside</button>
      </Modal>
    );
    // The close button is first in document order.
    expect(document.activeElement).toBe(screen.getByLabelText("Close modal"));
  });

  it("returns focus to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { rerender } = render(
      <Modal isOpen onClose={() => {}} title="Settings">
        <button>Inside</button>
      </Modal>
    );
    expect(document.activeElement).not.toBe(opener);

    rerender(
      <Modal isOpen={false} onClose={() => {}} title="Settings">
        <button>Inside</button>
      </Modal>
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("wraps Tab from the last focusable back to the first", () => {
    render(
      <Modal isOpen onClose={() => {}} title="Settings">
        <button>Inside</button>
      </Modal>
    );
    const close = screen.getByLabelText("Close modal");
    const inside = screen.getByText("Inside");

    inside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    // And backwards off the first element.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inside);
  });

  it("names the dialog with its title", () => {
    render(
      <Modal isOpen onClose={() => {}} title="Backends">
        <button>Inside</button>
      </Modal>
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Backends");
  });
});

// Ported from desk's dialogs.test.tsx `describe("Modal", ...)` block
// (dc4664b), adapted to this tree's isOpen/footer/portal Modal contract.
// Task 18's MERGE-NOTES verified qwen's Modal does not reproduce desk's
// focus-theft bug (the effect that moves focus depends on [isOpen,
// focusables], not onClose's identity) -- these cover the genuinely new
// hardening desk added on top of that: the Escape-only repeat guard and the
// backdrop mousedown-vs-click distinction, plus a regression guard for the
// re-render/fresh-onClose-closure case Task 18 flagged as untested.
describe("Modal defense-in-depth (ported from desk dc4664b)", () => {
  it("does not let a repeated Tab keydown escape the trap (the repeat guard belongs only to Escape)", () => {
    render(
      <Modal isOpen onClose={() => {}} title="Test">
        <button>first</button>
        <button>second</button>
      </Modal>
    );
    const closeBtn = screen.getByLabelText("Close modal");
    const second = screen.getByText("second");
    second.focus();
    const evt = new KeyboardEvent("keydown", {
      key: "Tab", bubbles: true, cancelable: true, repeat: true,
    });
    document.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);
  });

  it("does not close when a text-selection drag starts inside the dialog and ends over the backdrop", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Test">
        <input aria-label="inner" defaultValue="hello" />
      </Modal>
    );
    const input = screen.getByLabelText("inner");
    const backdrop = document.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.mouseDown(input);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes on a genuine backdrop click (regression guard for the mousedown-target fix)", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Test">
        <button>inside</button>
      </Modal>
    );
    const backdrop = document.querySelector(".modal-backdrop") as HTMLElement;
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps focus in place when the parent re-renders and hands down a new onClose closure", () => {
    function Wrapper() {
      const [, setN] = useState(0);
      // A fresh arrow function every render, deliberately -- this is what
      // AppShell's inline `onClose={() => setBackendsOpen(false)}` handlers
      // do on every unrelated AppShell re-render (e.g. the pin shortcut).
      return (
        <>
          <button onClick={() => setN((v) => v + 1)}>rerender</button>
          <Modal isOpen onClose={() => {}} title="Test">
            <input aria-label="inner" />
          </Modal>
        </>
      );
    }
    render(<Wrapper />);
    const input = screen.getByLabelText("inner");
    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByText("rerender"));
    expect(document.activeElement).toBe(input);
  });
});
