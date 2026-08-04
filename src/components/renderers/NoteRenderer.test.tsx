import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NoteRenderer from "./NoteRenderer";

describe("NoteRenderer", () => {
  it("invites a note when empty", () => {
    render(<NoteRenderer text="" onChange={() => {}} />);
    expect(screen.getByText(/Click to add a note/)).toBeInTheDocument();
  });

  it("renders markdown when not editing", () => {
    render(<NoteRenderer text="# Heading" onChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
  });

  it("commits on blur", () => {
    const onChange = vi.fn();
    render(<NoteRenderer text="old" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const box = screen.getByLabelText("Note text");
    fireEvent.change(box, { target: { value: "new" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith("new");
  });

  it("does not write when nothing changed", () => {
    // Every click would otherwise persist the dashboard and refetch nothing
    // useful.
    const onChange = vi.fn();
    render(<NoteRenderer text="same" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.blur(screen.getByLabelText("Note text"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits on Cmd/Ctrl+Enter", () => {
    const onChange = vi.fn();
    render(<NoteRenderer text="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const box = screen.getByLabelText("Note text");
    fireEvent.change(box, { target: { value: "typed" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onChange).toHaveBeenCalledWith("typed");
  });

  it("abandons the edit on Escape", () => {
    // Escape means cancel everywhere else in the app.
    const onChange = vi.fn();
    render(<NoteRenderer text="original" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));

    const box = screen.getByLabelText("Note text");
    fireEvent.change(box, { target: { value: "discarded" } });
    fireEvent.keyDown(box, { key: "Escape" });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("original")).toBeInTheDocument();
  });

  it("keeps the draft when the prop changes mid-edit", () => {
    // A save elsewhere must not wipe what the user is typing.
    const { rerender } = render(<NoteRenderer text="a" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("Note text"), { target: { value: "typing" } });

    rerender(<NoteRenderer text="changed elsewhere" onChange={() => {}} />);
    expect((screen.getByLabelText("Note text") as HTMLTextAreaElement).value).toBe("typing");
  });
});
