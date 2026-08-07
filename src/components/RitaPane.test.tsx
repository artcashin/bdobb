import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import RitaPane from "./RitaPane";

describe("RitaPane", () => {
  it("renders the collapsed vertical tab, not the children, when not pinned/hovered", () => {
    render(
      <RitaPane pinned={false} sticky={false} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByText("Rita")).toBeInTheDocument();
    expect(screen.queryByText("chat content")).not.toBeInTheDocument();
  });

  it("renders the expanded body with children and a pin button when pinned", () => {
    render(
      <RitaPane pinned={true} sticky={false} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByText("chat content")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unpin/i })).toBeInTheDocument();
  });

  it("calls onTogglePin when the pin button is clicked", () => {
    const onTogglePin = vi.fn();
    render(
      <RitaPane pinned={false} sticky={true} onTogglePin={onTogglePin}>
        <div>chat content</div>
      </RitaPane>
    );
    // sticky only suppresses auto-collapse; the panel still needs a hover
    // (or pinned=true) to expand and reveal the pin button.
    fireEvent.mouseEnter(screen.getByLabelText("Rita AI pane"));
    fireEvent.click(screen.getByRole("button", { name: /pin/i }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  // Fix 4 (Task 7 review): a pending confirmation (post_to_symphony's gate)
  // raised while the pane is collapsed used to be completely invisible --
  // hasUnread is only set by chat activity, never by a confirmation being
  // registered -- leaving a plain "Rita" tab and a disabled input with no
  // clue why. needsDecision gets its own indicator so the user knows to open
  // the pane, distinct from (and shown in preference to) a plain unread reply.
  it("shows a needs-decision indicator, not a plain unread dot, when a confirmation is pending", () => {
    render(
      <RitaPane pinned={false} sticky={false} unread={true} needsDecision={true} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByLabelText(/needs your decision/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^new response from rita$/i)).not.toBeInTheDocument();
  });

  it("falls back to the plain unread dot when nothing needs a decision", () => {
    render(
      <RitaPane pinned={false} sticky={false} unread={true} needsDecision={false} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByLabelText(/new response from rita/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/needs your decision/i)).not.toBeInTheDocument();
  });

  it("applies the pinned class only when pinned", () => {
    const { rerender } = render(
      <RitaPane pinned={false} sticky={false} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByLabelText("Rita AI pane")).not.toHaveClass("pinned");

    rerender(
      <RitaPane pinned={true} sticky={false} onTogglePin={() => {}}>
        <div>chat content</div>
      </RitaPane>
    );
    expect(screen.getByLabelText("Rita AI pane")).toHaveClass("pinned");
  });
});
