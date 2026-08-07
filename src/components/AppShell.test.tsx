/** @jsxImportSource react */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AppShell from "./AppShell";
import * as agentClient from "../lib/agent/agentClient";
import * as mcpModule from "../lib/agent/mcp";
import type { AgentTool } from "../lib/agent/types";
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

  // Fix 1 + Fix 4 (Task 7 review): a pending post_to_symphony confirmation
  // must hold the pane open (Fix 1's fix, wired through AppShell exactly as
  // production does -- ChatPane.onStickyChange -> RitaPane's sticky prop),
  // and must surface a needs-decision indicator on the collapsed tab (Fix
  // 4) so a confirmation raised while nobody is looking isn't invisible.
  it("stays open despite the pointer leaving once a Symphony confirmation is pending, and flags it distinctly", async () => {
    const SYMPHONY_TOOL: AgentTool = {
      server_id: "symphony-bridge",
      name: "post_to_symphony",
      url: "https://bridge.test/mcp",
      endpoint: "",
      description: "Post a message to a Symphony room",
      input_schema: {},
    };
    vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
      tools: [SYMPHONY_TOOL],
      budgetExceeded: [],
      unreachable: [],
    });
    const runQuerySpy = vi
      .spyOn(agentClient, "runAgentQuery")
      .mockResolvedValue([]);

    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });

    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => { fireEvent.change(input, { target: { value: "post to symphony" } }); });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
    const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

    act(() => {
      void runAgentTool("symphony-bridge", "post_to_symphony", {
        streamId: "room1",
        message: "hello room",
      });
    });
    expect(await screen.findByText(/review and send/i)).toBeInTheDocument();

    // Walk away while the decision is still pending: without Fix 1 this
    // both collapses the pane and, because the dialog only renders inside
    // ChatPane, unmounts the dialog with it.
    await act(async () => { fireEvent.blur(input); });
    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(1000); });

    expect(pane().className).toContain("expanded");
    expect(screen.getByText(/review and send/i)).toBeInTheDocument();
  });

  // Fix 4's specific "invisible" scenario: hasUnread is only ever set by
  // chatStore's noteActivity() on stream events, never by a confirmation
  // being registered. Before the fix, a tool call arriving after the pane
  // had already folded (e.g. the turn took a while, the user stopped
  // watching) left a plain "Rita" tab and a permanently disabled input, with
  // no dot and no dialog to explain why -- runAgentTool's promise, and the
  // agent's turn with it, just sat there forever with no visible cause.
  it("shows a needs-decision indicator on the collapsed tab when a confirmation arrives after the pane has already folded", async () => {
    const SYMPHONY_TOOL: AgentTool = {
      server_id: "symphony-bridge",
      name: "post_to_symphony",
      url: "https://bridge.test/mcp",
      endpoint: "",
      description: "Post a message to a Symphony room",
      input_schema: {},
    };
    vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
      tools: [SYMPHONY_TOOL],
      budgetExceeded: [],
      unreachable: [],
    });
    let capturedRunAgentTool: agentClient.AgentToolRunner | undefined;
    vi.spyOn(agentClient, "runAgentQuery").mockImplementation(async (o) => {
      capturedRunAgentTool = o.runAgentTool;
      return new Promise(() => {}); // the turn stays in flight for this test
    });

    render(<AppShell />);
    await act(async () => { fireEvent.mouseEnter(pane()); });
    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => { fireEvent.change(input, { target: { value: "post to symphony" } }); });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => expect(capturedRunAgentTool).toBeDefined());

    // Nobody has invoked the Symphony tool yet -- the pane folds normally.
    await act(async () => { fireEvent.blur(input); });
    await act(async () => { fireEvent.mouseLeave(pane()); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(pane().className).not.toContain("expanded");
    expect(screen.queryByLabelText(/needs your decision/i)).not.toBeInTheDocument();

    // The agent's tool call arrives later, with nobody looking at the pane.
    act(() => {
      void capturedRunAgentTool!("symphony-bridge", "post_to_symphony", {
        streamId: "room1",
        message: "hello room",
      });
    });

    expect(screen.getByLabelText(/needs your decision/i)).toBeInTheDocument();
  });
});
