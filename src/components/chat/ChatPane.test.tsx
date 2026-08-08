import { useState } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as agentClientModule from "../../lib/agent/agentClient";
import * as mcpModule from "../../lib/agent/mcp";
import type { AgentTool } from "../../lib/agent/types";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { LOCAL_TOOL_SERVER_ID } from "../../lib/agent/localTools";
import ChatPane from "./ChatPane";
import RitaPane from "../RitaPane";

vi.mock("plotly.js-dist-min", () => ({
  default: {
    newPlot: vi.fn(),
    update: vi.fn(),
    unmount: vi.fn(),
    relayout: vi.fn(),
    deletePlot: vi.fn(),
    purge: vi.fn(),
  },
}));

vi.mock("../../stores/settingsStore", () => {
  return {
    useSettingsStore: vi.fn((selector) =>
      selector({
        settings: { ritaUrl: "http://localhost:8002", theme: "dark", contextSharing: false, mcpServers: [] },
        setRitaUrl: vi.fn(),
        setContextSharing: vi.fn(),
        setMcpServers: vi.fn(),
        load: vi.fn(),
      })
    ),
    __esModule: true,
  };
});

/** The settingsStore mock's default `settings`, as a base for tests that
 * need to override one field (e.g. `symphonyBridgeUrl`) without repeating
 * every other default. */
const DEFAULT_MOCK_SETTINGS = {
  ritaUrl: "http://localhost:8002",
  theme: "dark" as const,
  contextSharing: false,
  mcpServers: [] as const,
};

/** Overrides the mocked `useSettingsStore` for one test. Must be paired with
 * a call restoring the default (see `restoreDefaultMockSettings` below) so
 * the override doesn't leak into later tests -- `vi.clearAllMocks()` in the
 * top-level `beforeEach` clears call history but not a mock's
 * implementation. */
function mockSettings(overrides: Record<string, unknown>) {
  vi.mocked(useSettingsStore).mockImplementation((selector: any) =>
    selector({
      settings: { ...DEFAULT_MOCK_SETTINGS, ...overrides },
      setRitaUrl: vi.fn(),
      setContextSharing: vi.fn(),
      setMcpServers: vi.fn(),
      load: vi.fn(),
    })
  );
}

function restoreDefaultMockSettings() {
  mockSettings({});
}

describe("ChatPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // agents.json discovery is best-effort (see ChatPane's model-note
    // effect) — mocked to no agent by default so tests that don't care about
    // it don't hit the real network (jsdom has no agents.json to fetch).
    vi.spyOn(agentClientModule, "fetchAgentsJson").mockResolvedValue({});
  });

  it("renders chat pane with input field", () => {
    render(<ChatPane />);
    expect(screen.getByPlaceholderText("Message Rita...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send/i })).toBeInTheDocument();
  });

  // Desk Finding 10 (a11y): an accessible name beyond a placeholder-only
  // input, reachable by role/name queries regardless of placeholder text.
  it("gives the message input a real accessible name", () => {
    render(<ChatPane />);
    expect(screen.getByRole("textbox", { name: "Message Rita" })).toBeInTheDocument();
  });

  it("allows typing in input field", async () => {
    render(<ChatPane />);
    // Lets the mocked agents.json discovery promise settle under `act`
    // before the assertions below, rather than leaving it pending past the
    // end of the test.
    await act(async () => {});
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hello" } });
    expect(input).toHaveValue("Hello");
  });

  it("sends on Enter via the function-call-aware round trip", async () => {
    const spy = vi
      .spyOn(agentClientModule, "runAgentQuery")
      .mockResolvedValue([]);

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Hello" } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const opts = spy.mock.calls[0][0];
    // The whole point of the round trip: the agent must be handed a way to
    // pull widget data, and the full history, not just the newest message.
    expect(typeof opts.fetchWidgetData).toBe("function");
    expect(opts.messages[opts.messages.length - 1]).toEqual({
      role: "human",
      content: "Hello",
    });
    expect(opts.queryUrl).toMatch(/\/v1\/query$/);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("renders streamed text deltas", async () => {
    vi.spyOn(agentClientModule, "runAgentQuery").mockImplementation(async (o: any) => {
      o.onEvent({ kind: "chunk", delta: "Hel" });
      o.onEvent({ kind: "chunk", delta: "lo" });
      return [];
    });

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Hello")).toBeInTheDocument());
  });

  it("disables the input while a turn is in flight", async () => {
    let release!: () => void;
    vi.spyOn(agentClientModule, "runAgentQuery").mockImplementation(
      () => new Promise((res) => { release = () => res([]); })
    );

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    await waitFor(() => expect(input).toBeDisabled());
    await act(async () => { release(); });
    await waitFor(() => expect(input).toBeEnabled());
  });

  it("surfaces a failed turn as an error", async () => {
    vi.spyOn(agentClientModule, "runAgentQuery").mockRejectedValue(new Error("Network error"));

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText(/Network error/i)).toBeInTheDocument());
  });

  it("does not show an error when the turn is aborted", async () => {
    // The pane unmounts on hover-collapse, which aborts mid-stream; that is
    // not a failure and must not surface as one.
    const abort = new Error("aborted");
    abort.name = "AbortError";
    vi.spyOn(agentClientModule, "runAgentQuery").mockRejectedValue(abort);

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Test" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });

    await waitFor(() => expect(screen.getByPlaceholderText("Message Rita...")).toBeEnabled());
    expect(screen.queryByText(/aborted/i)).not.toBeInTheDocument();
  });

  // Carried requirement (Task 10 -> Task 17): agents.json discovery is wired
  // into ChatPane via fetchAgentsJson (which now runs desk's
  // normalizeAgentsJson/normalizeFeatures internally). The live `model`
  // select's `default` isn't always one of its own `options` (desk ChatPane
  // deviation note), so this must render as read-only text, not a
  // functional dropdown that could let a user pick an option that hard-fails.
  it("renders the discovered model as a read-only note, not a functional dropdown", async () => {
    vi.spyOn(agentClientModule, "fetchAgentsJson").mockResolvedValue({
      openbb_agent_rita: {
        name: "Rita",
        description: "",
        endpoints: { query: "/v1/query" },
        features: {
          model: {
            label: "Model",
            type: "select",
            default: "openai:qwen3-coder",
            options: [{ label: "OpenAI: GPT-5.5", value: "openai:gpt-5.5" }],
          },
        },
      },
    });
    render(<ChatPane />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Model: openai:qwen3-coder/ })).toBeInTheDocument()
    );
    expect(screen.queryByRole("combobox", { name: /model/i })).not.toBeInTheDocument();
  });

  // Reviewer follow-up (Task 17): the "Model: X" note must describe what's
  // actually queried, not just decorate the toolbar — desk ChatPane.tsx
  // threads the discovered model into every query's workspace_options
  // (ChatPane.tsx:252,324). Previously bdobb rendered the note but
  // chatStore.send never forwarded anything, so workspace_options was
  // always {}.
  it("threads the discovered model into the query as workspaceOptions", async () => {
    vi.spyOn(agentClientModule, "fetchAgentsJson").mockResolvedValue({
      openbb_agent_rita: {
        name: "Rita",
        description: "",
        endpoints: { query: "/v1/query" },
        features: {
          model: {
            label: "Model",
            type: "select",
            default: "openai:qwen3-coder",
            options: [{ label: "OpenAI: GPT-5.5", value: "openai:gpt-5.5" }],
          },
        },
      },
    });
    const spy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

    render(<ChatPane />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Model: openai:qwen3-coder/ })).toBeInTheDocument()
    );
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].workspaceOptions).toEqual({ model: "openai:qwen3-coder" });
  });

  it("sends no workspaceOptions when no model feature was discovered", async () => {
    // The default beforeEach stub already resolves fetchAgentsJson to {}.
    const spy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0].workspaceOptions).toBeUndefined();
  });

  it("keeps the pane usable when agents.json discovery fails", async () => {
    vi.spyOn(agentClientModule, "fetchAgentsJson").mockRejectedValue(new Error("ECONNREFUSED"));
    render(<ChatPane />);
    await waitFor(() => expect(screen.getByPlaceholderText("Message Rita...")).toBeEnabled());
    expect(screen.queryByText(/Model:/)).not.toBeInTheDocument();
  });

  // Carried requirement (Task 9 -> Task 17): AssembleToolsResult.budgetExceeded
  // /unreachable must be visible in the chat UI, not just logged, so a reply
  // that's quietly missing a server's tools isn't unexplained.
  it("renders a visible warning when assembleTools reports a budget-exceeded MCP server", async () => {
    vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
      tools: null,
      budgetExceeded: [{
        serverId: "openbb-mcp",
        url: "https://openbb.example/mcp",
        toolCount: 219,
        payloadChars: 570687,
        message: "MCP server https://openbb.example/mcp advertises 219 tools, exceeding the request budget.",
      }],
      unreachable: [],
    });
    vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() =>
      expect(screen.getByText(/exceeding the request budget/)).toBeInTheDocument()
    );
  });

  it("renders a visible warning when assembleTools reports an unreachable MCP server", async () => {
    vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
      tools: null,
      budgetExceeded: [],
      unreachable: [{
        serverId: "stores-mcp",
        url: "https://stores.example/mcp",
        message: "MCP server https://stores.example/mcp is unreachable: timed out.",
      }],
    });
    vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() =>
      expect(screen.getByText(/stores.example\/mcp is unreachable/)).toBeInTheDocument()
    );
  });

  // Desk 2b8a646 (F3, privacy leak): a card's widget-derived MCP server is
  // dashboard context just as much as its widget ref is -- sending it while
  // contextSharing is off leaked the widget id and contacted a private MCP
  // server behind the user's back.
  it("does not leak a dashboard widget's MCP server to assembleTools when contextSharing is off", async () => {
    // The top-of-file settingsStore mock already sets contextSharing: false.
    const assembleSpy = vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
      tools: null, budgetExceeded: [], unreachable: [],
    });
    vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);
    const { useDashboardStore } = await import("../../stores/dashboardStore");
    const { useRegistryStore } = await import("../../stores/registryStore");
    useDashboardStore.setState({
      dashboards: [{
        id: "d1", name: "Main",
        cards: [{
          uuid: "c1", widgetId: "secret_widget", backendId: "nas",
          layout: { x: 0, y: 0, w: 10, h: 4 }, params: {}, view: "default",
        }],
      }],
      activeId: "d1",
    });
    useRegistryStore.setState({
      widgets: [{
        id: "secret_widget", backendId: "nas", name: "Secret", description: "", category: "",
        subCategory: null, type: "table", endpoint: "/x", gridData: { w: 10, h: 4 },
        source: [], runButton: false, raw: false, refetchInterval: null, params: [],
        dataKey: "results", columnsDefs: null, mcpUrl: "https://private.example/mcp",
      }],
      loading: false,
    });

    render(<ChatPane />);
    const input = screen.getByPlaceholderText("Message Rita...");
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(assembleSpy).toHaveBeenCalled());
    const [, dashboardMcpArg] = assembleSpy.mock.calls[0] as [unknown, unknown];
    expect(dashboardMcpArg).toEqual([]);
    await waitFor(() => expect(input).toBeEnabled());

    // Reset the shared stores while ChatPane is still mounted and subscribed
    // to them -- wrapped in act() since this itself triggers a re-render.
    act(() => {
      useDashboardStore.setState({ dashboards: [], activeId: null });
      useRegistryStore.setState({ widgets: [], loading: false });
    });
  });

  // Task 7: Rita's post_to_symphony arrives as an MCP tool call routed
  // through ChatPane's runAgentTool (assembled and handed to
  // agentClient.runAgentQuery, mocked below so this closure can be grabbed
  // and invoked directly, the same way other tests here inspect
  // opts.fetchWidgetData). A message must never reach the bridge without the
  // user explicitly approving it first.
  describe("post_to_symphony confirmation gate", () => {
    const SYMPHONY_TOOL: AgentTool = {
      server_id: "symphony-bridge",
      name: "post_to_symphony",
      url: "https://bridge.test/mcp",
      endpoint: "",
      description: "Post a message to a Symphony room",
      input_schema: {},
    };

    beforeEach(() => {
      useChatStore.getState().clear();
    });

    async function getRunAgentTool() {
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [SYMPHONY_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "post to symphony" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });

      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const opts = runQuerySpy.mock.calls[0][0];
      return opts.runAgentTool!;
    }

    it("does not call the MCP tool until the user approves", async () => {
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runAgentTool = await getRunAgentTool();

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      // Synchronous up to the first await: the confirmation is already
      // registered, and the tool has not run.
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(outcome).toBeUndefined();
      expect(useChatStore.getState().pendingToolConfirmation).toMatchObject({
        serverId: "symphony-bridge",
        toolName: "post_to_symphony",
        parameters: { streamId: "room1", message: "hello room" },
      });

      const id = useChatStore.getState().pendingToolConfirmation!.id;
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id, "approved");
      });

      await waitFor(() =>
        expect(callToolSpy).toHaveBeenCalledWith(
          "https://bridge.test/mcp",
          "post_to_symphony",
          { streamId: "room1", message: "hello room" }
        )
      );
      expect(outcome).toEqual({ content: "sent" });
      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
    });

    it("never calls the MCP tool when the user declines, and reports the decline to the agent", async () => {
      const callToolSpy = vi.spyOn(mcpModule, "callMcpTool");
      const runAgentTool = await getRunAgentTool();

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      const id = useChatStore.getState().pendingToolConfirmation!.id;
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id, "declined");
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(callToolSpy).not.toHaveBeenCalled();
      // The result must read as a refusal, not a silent success, so the
      // model doesn't tell the user the message went out.
      expect(outcome!.isError).toBe(true);
      expect(outcome!.content).toMatch(/declined/i);
      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
    });

    it("shows the destination and message content in a Review and Send dialog", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "trading-desk",
          message: "Markets are closed for the holiday.",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      // Pinned to the specific elements the user actually reads, not "does
      // this text appear anywhere in the DOM". jsdom does not implement
      // <details> collapsing, and getAllByText does not filter on
      // visibility, so an assertion against "anywhere" would still pass even
      // if the human-readable summary line were deleted and only the raw
      // JSON fallback (which is also always in the DOM) carried the text.
      const summary = document.querySelector(".symphony-confirm-summary");
      expect(summary).toBeTruthy();
      expect(summary!.textContent).toContain("trading-desk");
      const messageEl = document.querySelector(".symphony-confirm-message");
      expect(messageEl!.textContent).toBe("Markets are closed for the holiday.");
    });

    // Fix 2 (Task 7 review): when none of the known parameter names match,
    // the old dialog silently dropped the parenthetical -- "Rita wants to
    // post this message to Symphony:" read as complete and confident with no
    // hint the destination was actually unknown. Both halves of the fix are
    // pinned here: an explicit callout, and the raw-parameters fallback
    // defaulting open instead of staying an opt-in collapsed <details>.
    it("says so explicitly when the destination can't be determined, and opens the raw parameters", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          channel: "trading-desk", // not one of the recognized destination keys
          message: "Markets are closed for the holiday.",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const summary = document.querySelector(".symphony-confirm-summary");
      // No parenthetical destination guessed onto the confident sentence.
      expect(summary!.textContent).toBe("Rita wants to post this message to Symphony:");
      expect(
        screen.getByText(/destination could not be determined/i)
      ).toBeInTheDocument();
      const details = document.querySelector("details");
      expect(details).toHaveAttribute("open");
    });

    // Fix 2's second half: a payload carrying both a human name and a
    // resolved id is ambiguous about which one the bridge actually routes
    // by. Silently picking the first match (old precedence-order behavior)
    // could show the user a destination that isn't where the message goes.
    it("shows every known destination candidate, not just the first, when more than one is present", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "stream-42",
          room: "trading-desk",
          message: "Markets are closed for the holiday.",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const summary = document.querySelector(".symphony-confirm-summary");
      // Ambiguous, so the summary line does not pick a winner between them.
      expect(summary!.textContent).toBe("Rita wants to post this message to Symphony:");
      const warning = screen.getByText(/multiple possible destinations/i);
      expect(warning.textContent).toContain("streamId: stream-42");
      expect(warning.textContent).toContain("room: trading-desk");
      const details = document.querySelector("details");
      expect(details).toHaveAttribute("open");
    });

    // Fix 3 (Task 7 review, minor): streamId/stream_id is a camelCase/
    // snake_case duplicate naming the SAME destination, not two candidate
    // destinations -- collapsing by distinct value before deciding ambiguity
    // must treat this as resolved, not raise a false "multiple possible
    // destinations" alarm.
    it("does not flag camelCase/snake_case duplicates of the same value as ambiguous", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "trading-desk",
          stream_id: "trading-desk",
          message: "Markets are closed for the holiday.",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const summary = document.querySelector(".symphony-confirm-summary");
      expect(summary!.textContent).toBe("Rita wants to post this message to Symphony (trading-desk):");
      expect(screen.queryByText(/multiple possible destinations/i)).not.toBeInTheDocument();
    });

    // Blocking 1 (final review): message collapsed to the first key match
    // (old behavior) instead of surfacing every candidate the same way
    // destination already did -- a payload with both a benign `message` and
    // a divergent `text` showed only the benign one.
    it("shows every known message candidate, not just the first, when more than one distinct value is present", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "Confirming lunch at noon",
          text: "Wire $50,000 to account 4471 now",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const messageEl = document.querySelector(".symphony-confirm-message");
      // Neither candidate is silently trusted over the other.
      expect(messageEl!.textContent).toBe("(no message text found -- see raw parameters below)");
      const warning = screen.getByText(/multiple possible messages/i);
      expect(warning.textContent).toContain("message: Confirming lunch at noon");
      expect(warning.textContent).toContain("text: Wire $50,000 to account 4471 now");
      const details = document.querySelector("details");
      expect(details).toHaveAttribute("open");
    });

    it("does not flag camelCase/snake_case-style duplicates of the same message value as ambiguous", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "Markets are closed for the holiday.",
          text: "Markets are closed for the holiday.",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const messageEl = document.querySelector(".symphony-confirm-message");
      expect(messageEl!.textContent).toBe("Markets are closed for the holiday.");
      expect(screen.queryByText(/multiple possible messages/i)).not.toBeInTheDocument();
    });

    it("says so explicitly when the message text can't be determined", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          caption: "not one of the recognized message keys",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      expect(screen.getByText(/message text could not be determined/i)).toBeInTheDocument();
    });

    // Blocking 1's second requirement: raw parameters must always be visible
    // by default, not just when something is unresolved/ambiguous -- a key
    // outside both known sets (an attachment, a mentions list, a second
    // recipient) would otherwise be hidden behind an opt-in <details> for
    // the ordinary, fully-resolved case.
    it("keeps raw parameters open by default even when destination and message both resolve cleanly", async () => {
      vi.spyOn(mcpModule, "callMcpTool").mockResolvedValue({ content: [] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
          attachment: { filename: "secret-plan.pdf" },
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const details = document.querySelector("details");
      expect(details).toHaveAttribute("open");
    });

    it("declining via the dialog's Decline button resolves the gate", async () => {
      const callToolSpy = vi.spyOn(mcpModule, "callMcpTool");
      const runAgentTool = await getRunAgentTool();

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      const declineBtn = await screen.findByRole("button", { name: /decline/i });
      await act(async () => {
        fireEvent.click(declineBtn);
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(outcome!.isError).toBe(true);
      expect(screen.queryByText(/review and send/i)).not.toBeInTheDocument();
    });

    it("approving via the dialog's Send button runs the tool", async () => {
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runAgentTool = await getRunAgentTool();

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        });
      });

      const sendBtn = await screen.findByRole("button", { name: /^send$/i });
      await act(async () => {
        fireEvent.click(sendBtn);
      });

      await waitFor(() => expect(callToolSpy).toHaveBeenCalled());
      expect(screen.queryByText(/review and send/i)).not.toBeInTheDocument();
    });

    it("clearing the chat mid-confirmation declines it instead of leaving it stuck", async () => {
      const callToolSpy = vi.spyOn(mcpModule, "callMcpTool");
      const runAgentTool = await getRunAgentTool();

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      expect(useChatStore.getState().pendingToolConfirmation).not.toBeNull();

      act(() => {
        useChatStore.getState().clear();
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(outcome!.isError).toBe(true);
      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
    });

    // The stated reason the confirmation lives in chatStore rather than
    // ChatPane's own local state: RitaPane unmounts its children when it
    // collapses (hover-away, or -- before Fix 1 -- the outside-tap bug this
    // dialog itself could trigger). If the pending confirmation lived in a
    // useState here, unmounting ChatPane would discard it and leave
    // runAgentTool's promise permanently unsettled. This was previously
    // asserted only by the design comment in chatStore.ts, not by a test.
    it("keeps a pending confirmation alive in the store when ChatPane unmounts", async () => {
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [SYMPHONY_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      const { unmount } = render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "post to symphony" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      const id = useChatStore.getState().pendingToolConfirmation!.id;
      expect(id).toBeTruthy();

      unmount();

      // Still resolvable after the component that rendered the dialog is
      // gone -- the confirmation belongs to the store, not the component.
      expect(useChatStore.getState().pendingToolConfirmation?.id).toBe(id);
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id, "approved");
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(callToolSpy).toHaveBeenCalled();
      expect(outcome).toEqual({ content: "sent" });
    });

    // The gate is store-level plumbing (one `pendingToolConfirmation` slot),
    // but the agent can make two separate post_to_symphony calls across a
    // turn (e.g. two different rooms). This test resolves the first call
    // before the second is ever raised, so it exercises sequential reuse of
    // that one slot -- each call gets its own id, and resolving the second
    // does not affect the outcome already recorded for the first. It does
    // NOT exercise two confirmations pending or resolving concurrently; the
    // agent protocol only ever raises one function call at a time, so that
    // case doesn't arise here.
    it("gives two post_to_symphony calls in the same turn their own confirmation", async () => {
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runAgentTool = await getRunAgentTool();

      let outcome1: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "first",
        }).then((r) => {
          outcome1 = r;
        });
      });
      const id1 = useChatStore.getState().pendingToolConfirmation!.id;
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id1, "approved");
      });
      await waitFor(() => expect(outcome1).toBeDefined());

      let outcome2: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room2",
          message: "second",
        }).then((r) => {
          outcome2 = r;
        });
      });
      const id2 = useChatStore.getState().pendingToolConfirmation!.id;
      expect(id2).not.toBe(id1);
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id2, "declined");
      });
      await waitFor(() => expect(outcome2).toBeDefined());

      expect(outcome1).toEqual({ content: "sent" });
      expect(outcome2!.isError).toBe(true);
      expect(callToolSpy).toHaveBeenCalledTimes(1);
      expect(callToolSpy).toHaveBeenCalledWith(
        "https://bridge.test/mcp",
        "post_to_symphony",
        { streamId: "room1", message: "first" }
      );
    });

    // The gate sits above the server_id branch in runAgentTool -- above both
    // the MCP dispatch (tested elsewhere in this file) and the local-tool
    // dispatch. Routing a post_to_symphony call through
    // LOCAL_TOOL_SERVER_ID pins that placement against a refactor that might
    // otherwise only re-check the gate on the MCP path.
    it("gates a post_to_symphony call routed through the local-tool server_id too", async () => {
      const runAgentTool = await getRunAgentTool();

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool(LOCAL_TOOL_SERVER_ID, "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      expect(outcome).toBeUndefined();
      const pending = useChatStore.getState().pendingToolConfirmation;
      expect(pending).toMatchObject({
        serverId: LOCAL_TOOL_SERVER_ID,
        toolName: "post_to_symphony",
      });

      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(pending!.id, "approved");
      });

      // Falls through to executeLocalTool, which doesn't recognize
      // post_to_symphony -- proof the gate ran above that dispatch rather
      // than the call being (wrongly) treated as an MCP call regardless of
      // server_id.
      await waitFor(() => expect(outcome).toBeDefined());
      expect(outcome).toEqual({ content: "Unknown tool: post_to_symphony", isError: true });
    });
  });

  // Fix 1 (Task 7 review, IMPORTANT): the name pattern alone (`/symphony/i`)
  // fails OPEN for a bridge tool that just isn't named anything like
  // "symphony" -- `send_message`, `post_message`, etc are all plausible
  // names for the same bridge. This second trigger gates on provenance
  // (the call's resolved MCP server URL matches settings.symphonyBridgeUrl)
  // instead, OR'd onto the name check so it can only ever widen gating.
  describe("Fix 1: provenance gate for non-symphony-named tools from the bridge server", () => {
    // The bridge's HTTP base (what settings.symphonyBridgeUrl actually holds
    // -- chatShare.ts posts to `${bridgeUrl}/messages`) and its MCP `/mcp`
    // endpoint (what an AgentTool.url actually holds) are two different
    // paths on the same origin, never string-equal in a real install. Using
    // the same literal for both here would validate an impossible
    // configuration -- see Task 7 review.
    const BRIDGE_BASE_URL = "https://bridge.test";
    const BRIDGE_MCP_URL = "https://bridge.test/mcp";

    afterEach(() => {
      restoreDefaultMockSettings();
    });

    it("gates send_message when it originates from the configured Symphony bridge server", async () => {
      mockSettings({ symphonyBridgeUrl: BRIDGE_BASE_URL });
      const SEND_MESSAGE_TOOL: AgentTool = {
        server_id: "symphony-bridge",
        name: "send_message",
        url: BRIDGE_MCP_URL,
        endpoint: "",
        description: "Send a message via the bridge",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [SEND_MESSAGE_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "send it" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "send_message", { text: "hi" }).then((r) => {
          outcome = r;
        });
      });

      // Gated: not called until approved, even though the name doesn't
      // contain "symphony" at all.
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(useChatStore.getState().pendingToolConfirmation).toMatchObject({
        serverId: "symphony-bridge",
        toolName: "send_message",
      });

      const id = useChatStore.getState().pendingToolConfirmation!.id;
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id, "approved");
      });

      await waitFor(() => expect(callToolSpy).toHaveBeenCalled());
      expect(outcome).toEqual({ content: "sent" });
    });

    it("does not gate a non-Symphony tool from a non-Symphony server", async () => {
      mockSettings({ symphonyBridgeUrl: BRIDGE_BASE_URL });
      const OTHER_TOOL: AgentTool = {
        server_id: "weather-server",
        name: "get_weather",
        url: "https://weather.example/mcp",
        endpoint: "",
        description: "Get the current weather",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [OTHER_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sunny" }] });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "what's the weather" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      await act(async () => {
        outcome = await runAgentTool("weather-server", "get_weather", { city: "NYC" });
      });

      // Neither trigger matches (name has no "symphony", server isn't the
      // bridge) -- the broadened gate must not have over-widened into
      // gating everything.
      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
      expect(callToolSpy).toHaveBeenCalledWith("https://weather.example/mcp", "get_weather", { city: "NYC" });
      expect(outcome).toEqual({ content: "sunny" });
    });

    // Regression: isFromSymphonyBridge must treat an empty/unset bridge URL
    // as "matches nothing", not as a wildcard that happens to match every
    // origin. Previously this rested on code inspection alone (Task 7).
    it("does not gate a non-local MCP tool when symphonyBridgeUrl is empty", async () => {
      mockSettings({ symphonyBridgeUrl: "" });
      const OTHER_TOOL: AgentTool = {
        server_id: "weather-server",
        name: "get_weather",
        url: "https://weather.example/mcp",
        endpoint: "",
        description: "Get the current weather",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [OTHER_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sunny" }] });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "what's the weather" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      await act(async () => {
        outcome = await runAgentTool("weather-server", "get_weather", { city: "NYC" });
      });

      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
      expect(callToolSpy).toHaveBeenCalledWith("https://weather.example/mcp", "get_weather", { city: "NYC" });
      expect(outcome).toEqual({ content: "sunny" });
    });

    // Regression: origin comparison must not become a substring/prefix match
    // -- a tool served from a different origin than the configured bridge,
    // with a non-Symphony name, must not be gated (Task 7).
    it("does not gate a non-Symphony tool served from a different origin than the bridge", async () => {
      mockSettings({ symphonyBridgeUrl: BRIDGE_BASE_URL });
      const OTHER_ORIGIN_TOOL: AgentTool = {
        server_id: "other-server",
        name: "send_message",
        url: "https://other.test/mcp",
        endpoint: "",
        description: "Send a message via an unrelated server",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [OTHER_ORIGIN_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const callToolSpy = vi
        .spyOn(mcpModule, "callMcpTool")
        .mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "send it" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      await act(async () => {
        outcome = await runAgentTool("other-server", "send_message", { text: "hi" });
      });

      expect(useChatStore.getState().pendingToolConfirmation).toBeNull();
      expect(callToolSpy).toHaveBeenCalledWith("https://other.test/mcp", "send_message", { text: "hi" });
      expect(outcome).toEqual({ content: "sent" });
    });
  });

  // Fix 2 (Task 7 review, IMPORTANT): Fix 1's broadened gate can now catch
  // read-only or unrelated tools (symphony_list_rooms, a bridge tool named
  // send_message, ...) that are not actually posting a message. The dialog
  // must not assert a destination/message it never parsed for those.
  describe("Fix 2: dialog phrasing matches what the gate actually knows", () => {
    // Several tests below leave a confirmation pending (asserting the dialog
    // renders, without ever resolving it) -- previously harmless because a
    // later test's own requestToolConfirmation call would just silently
    // overwrite whatever was left over. Now that a second call queues behind
    // an existing pending one instead of overwriting it (chatStore's
    // requestToolConfirmation), a leftover from the previous test would
    // starve the next test's own confirmation from ever becoming visible.
    beforeEach(() => {
      useChatStore.getState().clear();
    });

    it("uses neutral phrasing naming the tool and server, and claims no message/destination, for a non-post_to_symphony call", async () => {
      const LIST_ROOMS_TOOL: AgentTool = {
        server_id: "symphony-bridge",
        name: "symphony_list_rooms",
        url: "https://bridge.test/mcp",
        endpoint: "",
        description: "List Symphony rooms",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [LIST_ROOMS_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "list the rooms" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      act(() => {
        void runAgentTool("symphony-bridge", "symphony_list_rooms", {});
      });

      expect(await screen.findByText(/review and confirm/i)).toBeInTheDocument();
      const summary = document.querySelector(".symphony-confirm-summary");
      expect(summary!.textContent).toContain("symphony_list_rooms");
      expect(summary!.textContent).toContain("symphony-bridge");
      // Never asserts more than it knows: no claim of a message or a
      // destination for a tool it doesn't know posts one.
      expect(screen.queryByText(/wants to post this message/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/destination could not be determined/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no message text found/i)).not.toBeInTheDocument();
    });

    it("phrases the model-facing decline message to match the dialog's neutral phrasing for a non-post_to_symphony call", async () => {
      // The dialog itself only asserts "wants to post this message" for a
      // genuine post_to_symphony call -- for anything else the broadened
      // gate also catches, it names the tool/server instead. The decline
      // text handed back to the model must not assert more than the dialog
      // itself claimed.
      const LIST_ROOMS_TOOL: AgentTool = {
        server_id: "symphony-bridge",
        name: "symphony_list_rooms",
        url: "https://bridge.test/mcp",
        endpoint: "",
        description: "List Symphony rooms",
        input_schema: {},
      };
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [LIST_ROOMS_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "list the rooms" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "symphony_list_rooms", {}).then((r) => {
          outcome = r;
        });
      });

      const id = useChatStore.getState().pendingToolConfirmation!.id;
      await act(async () => {
        useChatStore.getState().resolveToolConfirmation(id, "declined");
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(outcome!.isError).toBe(true);
      expect(outcome!.content).not.toMatch(/symphony message/i);
      expect(outcome!.content).toMatch(/symphony_list_rooms/);
      expect(outcome!.content).toMatch(/symphony-bridge/);
      expect(outcome!.content).toMatch(/declined/i);
    });

    it("still shows the original confident phrasing for a genuine post_to_symphony call (regression guard)", async () => {
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
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<ChatPane />);
      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "post to symphony" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        });
      });

      expect(await screen.findByText(/review and send/i)).toBeInTheDocument();
      const summary = document.querySelector(".symphony-confirm-summary");
      expect(summary!.textContent).toBe("Rita wants to post this message to Symphony (room1):");
    });
  });

  // Fix 1 (Task 7 review, CRITICAL): on a coarse pointer, Modal portals the
  // confirmation dialog to document.body, outside the `.rita-pane` aside
  // useHoverPanel's outside-tap detector treats as "inside". Before the fix,
  // any tap on the dialog (Send, Decline, the close X, the backdrop) was
  // read as an outside tap and collapsed+unmounted the pane -- taking the
  // dialog with it -- before the tap's click could ever reach the button,
  // deadlocking the turn. This renders the real RitaPane+ChatPane pairing
  // (not ChatPane alone) so the actual sticky wiring between them is what's
  // under test, not a mocked stand-in for it.
  describe("Fix 1: coarse-pointer dialog taps must not collapse the pane", () => {
    const SYMPHONY_TOOL: AgentTool = {
      server_id: "symphony-bridge",
      name: "post_to_symphony",
      url: "https://bridge.test/mcp",
      endpoint: "",
      description: "Post a message to a Symphony room",
      input_schema: {},
    };

    /** A pointerdown as useHoverPanel's document-level capture listener sees
     * it. jsdom has no real PointerEvent constructor, so this hand-builds
     * the one property the listener reads, the same way
     * useHoverPanel.touch.test.ts does for the hook in isolation. */
    function coarseTap(el: Element) {
      const e = new Event("pointerdown", { bubbles: true }) as PointerEvent & {
        pointerType: string;
      };
      Object.defineProperty(e, "pointerType", { value: "touch" });
      el.dispatchEvent(e);
    }

    /** Mirrors AppShell's RitaPane/ChatPane wiring: ChatPane reports its
     * desired stickiness (focus, or now, a pending Symphony confirmation)
     * back up, and that becomes RitaPane's `sticky` prop. */
    function Harness() {
      const [sticky, setSticky] = useState(false);
      return (
        <RitaPane pinned={false} sticky={sticky} onTogglePin={() => {}}>
          <ChatPane onStickyChange={setSticky} />
        </RitaPane>
      );
    }

    beforeEach(() => {
      useChatStore.getState().clear();
      // Coarse pointer (touch) is what arms useHoverPanel's outside-tap
      // capture listener in the first place -- see usePointerKind.ts.
      const mq = {
        matches: false, // "(pointer: fine)" does not match under touch
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mq));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("does not collapse the pane on a coarse-pointer tap on the dialog's Decline button, and Decline still works", async () => {
      const callToolSpy = vi.spyOn(mcpModule, "callMcpTool");
      vi.spyOn(mcpModule, "assembleTools").mockResolvedValue({
        tools: [SYMPHONY_TOOL],
        budgetExceeded: [],
        unreachable: [],
      });
      const runQuerySpy = vi.spyOn(agentClientModule, "runAgentQuery").mockResolvedValue([]);

      render(<Harness />);
      // Open the pane so ChatPane mounts (RitaPane renders no children at
      // all while collapsed).
      fireEvent.mouseEnter(screen.getByLabelText("Rita AI pane"));

      const input = screen.getByPlaceholderText("Message Rita...");
      fireEvent.change(input, { target: { value: "post to symphony" } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
      await waitFor(() => expect(runQuerySpy).toHaveBeenCalled());
      const runAgentTool = runQuerySpy.mock.calls[0][0].runAgentTool!;

      let outcome: { content: string; isError?: boolean } | null | undefined;
      act(() => {
        void runAgentTool("symphony-bridge", "post_to_symphony", {
          streamId: "room1",
          message: "hello room",
        }).then((r) => {
          outcome = r;
        });
      });

      const declineBtn = await screen.findByRole("button", { name: /decline/i });

      // The hazard: a bare pointerdown on the (portalled-outside-the-pane)
      // dialog must not be read as "tapped outside" and collapse the pane.
      await act(async () => {
        coarseTap(declineBtn);
      });
      expect(screen.getByPlaceholderText("Message Rita...")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();

      // The tap's click must still reach the button and actually decline.
      await act(async () => {
        fireEvent.click(declineBtn);
      });

      await waitFor(() => expect(outcome).toBeDefined());
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(outcome!.isError).toBe(true);
      expect(outcome!.content).toMatch(/declined/i);
      expect(screen.queryByText(/review and send/i)).not.toBeInTheDocument();
      // The pane itself is still open and usable afterward, not collapsed.
      expect(screen.getByPlaceholderText("Message Rita...")).toBeInTheDocument();
    });
  });
});
