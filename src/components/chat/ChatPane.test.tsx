import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as agentClientModule from "../../lib/agent/agentClient";
import * as mcpModule from "../../lib/agent/mcp";
import ChatPane from "./ChatPane";

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
});
