/** @jsxImportSource react */

import { act, fireEvent, render, screen } from "@testing-library/react";
import AppShell from "./AppShell";
import * as agentClient from "../lib/agent/agentClient";
import { useChatStore } from "../stores/chatStore";
import { useDashboardStore } from "../stores/dashboardStore";

beforeEach(() => {
  useDashboardStore.setState({ dashboards: [], activeId: null });
  // chatStore is module state; without this a transcript leaks between tests.
  useChatStore.getState().clear();
  useChatStore.setState({ paneOpen: false });
});

  function shell(): HTMLElement {
    const element = document.querySelector(".app-shell") as HTMLElement;
    if (!element) {
      throw new Error("Element .app-shell not found");
    }
    return element;
  }

function dispatchShortcut(overrides: Partial<KeyboardEventInit> = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      shiftKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...overrides,
    })
  );
}

describe("AppShell", () => {
  it("toggles the rita-pinned class on Cmd+Shift+A", () => {
    render(<AppShell />);
    expect(shell()).not.toHaveClass("rita-pinned");
    act(() => dispatchShortcut());
    expect(shell()).toHaveClass("rita-pinned");
    act(() => dispatchShortcut());
    expect(shell()).not.toHaveClass("rita-pinned");
  });

  it("also responds to Ctrl+Shift+A", () => {
    render(<AppShell />);
    act(() => dispatchShortcut({ metaKey: false, ctrlKey: true }));
    expect(shell()).toHaveClass("rita-pinned");
  });

  it("ignores auto-repeated keydown events from holding the shortcut down", () => {
    render(<AppShell />);
    act(() => dispatchShortcut()); // real keydown -> pins
    expect(shell()).toHaveClass("rita-pinned");
    act(() => {
      dispatchShortcut({ repeat: true });
      dispatchShortcut({ repeat: true });
      dispatchShortcut({ repeat: true });
    });
    // still pinned, not thrashed back off by the repeats
    expect(shell()).toHaveClass("rita-pinned");
  });

  it("toggles pinned via the Rita pane's pin button", () => {
    render(<AppShell />);
    fireEvent.mouseEnter(screen.getByLabelText("Rita AI pane"));
    fireEvent.click(screen.getByRole("button", { name: /pin/i }));
    expect(shell()).toHaveClass("rita-pinned");
  });

  it("renders the left rail and the collapsed Rita strip by default", () => {
    render(<AppShell />);
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
    expect(screen.getByText("Rita")).toBeInTheDocument();
  });

  // Finding 3 (desk dc4664b): a startup failure used to be all-or-nothing
  // and log-only -- the user saw nothing but DashboardGrid's neutral "No
  // dashboard selected." AppShell is where App.tsx's independent per-store
  // startup results become a banner naming what actually failed.
  describe("startup error banner (Finding 3)", () => {
    it("renders nothing when startupErrors is empty or omitted", () => {
      render(<AppShell />);
      expect(document.querySelector(".startup-error-banner")).not.toBeInTheDocument();
      render(<AppShell startupErrors={[]} />);
      expect(document.querySelectorAll(".startup-error-banner")).toHaveLength(0);
    });

    it("names every failed step in a visible banner", () => {
      render(<AppShell startupErrors={["settings", "backends"]} />);
      const banner = document.querySelector(".startup-error-banner");
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent("settings");
      expect(banner).toHaveTextContent("backends");
    });
  });

  it("does not steal focus out of an open dialog when the app's own pin shortcut fires " +
    "(Task 18: AppShell's inline onClose handlers hand BackendsDialog a fresh closure on every " +
    "re-render, e.g. this shortcut's setPinned -- Modal's focus-move effect must not react to that)", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Backend" }));
    const nameInput = screen.getByLabelText("Name");
    act(() => nameInput.focus());
    expect(document.activeElement).toBe(nameInput);

    act(() => dispatchShortcut()); // AppShell's own Cmd+Shift+A pin toggle re-renders AppShell
    expect(document.activeElement).toBe(nameInput);
  });
});

describe("Rita pane stickiness", () => {
  function pane(): HTMLElement {
    return document.querySelector(".rita-pane") as HTMLElement;
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses after the delay when nothing holds it open", async () => {
    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });
    expect(pane().className).toContain("expanded");

    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(pane().className).not.toContain("expanded");
  });

  it("stays open while the chat input has focus, regardless of pointer", async () => {
    // The spec requires this explicitly, and it silently did not work: the
    // sticky flag existed but nothing ever set it.
    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });

    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => { fireEvent.focus(input); });
    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(1000); });

    expect(pane().className).toContain("expanded");
  });

  it("collapses once focus is released and the pointer is already away", async () => {
    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });

    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => { fireEvent.focus(input); });
    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(pane().className).toContain("expanded");

    await act(async () => { fireEvent.blur(input); });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(pane().className).not.toContain("expanded");
  });

  it("collapses while a turn streams, and flags the answer as unread", async () => {
    // Deliberate change from the original spec, which pinned the pane open
    // for the whole turn. The premise of the layout is that panels get out of
    // the way; the turn now lives in chatStore and survives the unmount, so
    // an unread dot is enough.
    let finish!: () => void;
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o: any) => {
      await new Promise<void>((res) => { finish = res; });
      o.onEvent({ kind: "chunk", delta: "the answer" });
      return [];
    });

    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });

    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => { fireEvent.change(input, { target: { value: "hi" } }); });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    // Walk away mid-turn: the pane folds instead of holding the screen.
    await act(async () => { fireEvent.blur(input); });
    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(pane().className).not.toContain("expanded");
    expect(screen.queryByRole("status", { name: /new response/i })).not.toBeInTheDocument();

    // The stream completes with nobody watching.
    await act(async () => { finish(); });
    expect(screen.getByRole("status", { name: /new response/i })).toBeInTheDocument();

    // Reopening shows the answer and clears the marker.
    await act(async () => { fireEvent.mouseEnter(pane()); });
    expect(screen.getByText("the answer")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /new response/i })).not.toBeInTheDocument();
  });
});
