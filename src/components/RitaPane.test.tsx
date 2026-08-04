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
