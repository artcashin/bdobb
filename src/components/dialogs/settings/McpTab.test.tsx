import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import McpTab from "./McpTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";
import { assembleTools, clearMcpCache } from "../../../lib/agent/mcp";

vi.mock("../../../lib/logger", () => ({
  logError: vi.fn(),
}));

vi.mock("../../../lib/agent/mcp", () => ({
  assembleTools: vi.fn(async () => ({ tools: null, budgetExceeded: [], unreachable: [] })),
  clearMcpCache: vi.fn(),
}));

const baseSettings = {
  ...DEFAULT_SETTINGS,
  mcpServers: [{ id: "mcp-1", url: "http://localhost:7769/mcp", enabled: true }],
};

function renderTab(over: Partial<typeof baseSettings> = {}) {
  const onChange = vi.fn();
  const settings = { ...baseSettings, ...over };
  const { rerender } = render(<McpTab settings={settings} onChange={onChange} fieldIds="t" />);
  return {
    onChange,
    rerender: (next: typeof baseSettings) =>
      rerender(<McpTab settings={next} onChange={onChange} fieldIds="t" />),
  };
}

describe("McpTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders MCP servers list", () => {
    renderTab();
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:7769/mcp")).toBeInTheDocument();
  });

  it("disables Add and warns when the new MCP server URL is not a valid http(s) URL", () => {
    renderTab();
    const input = screen.getByLabelText("New MCP server URL");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByText("Add")).toBeDisabled();
    expect(screen.getByText("Not a valid URL.")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    expect(screen.getByText("Add")).toBeDisabled();

    fireEvent.change(input, { target: { value: "http://localhost:9999/mcp" } });
    expect(screen.getByText("Add")).not.toBeDisabled();
  });

  // --- Carried requirement 3 (adjudicated): desk's SettingsDialog surfaces
  // MCP budget/unreachable state inline (not chat-only, unlike Task 17's
  // transient chat-turn banner), so it is ported here too. ---

  it("shows the tool count after checking the MCP budget", async () => {
    vi.mocked(assembleTools).mockResolvedValueOnce({
      tools: [{ server_id: "mcp-1", name: "t", url: "u", endpoint: "e", description: "d", input_schema: {} }] as any,
      budgetExceeded: [],
      unreachable: [],
    });
    renderTab();
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());
  });

  it("marks a server whose MCP discovery failed instead of giving a false all-clear", async () => {
    vi.mocked(assembleTools).mockResolvedValueOnce({
      tools: null,
      budgetExceeded: [],
      unreachable: [{ serverId: "mcp-1", url: "http://localhost:7769/mcp", message: "connection refused" }],
    });
    renderTab();
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/unreachable/i)).toBeInTheDocument());
  });

  it("re-discovers fresh state on each press instead of reporting session-stale results", async () => {
    vi.mocked(assembleTools)
      .mockResolvedValueOnce({
        tools: [{ server_id: "mcp-1", name: "t", url: "u", endpoint: "e", description: "d", input_schema: {} }] as any,
        budgetExceeded: [],
        unreachable: [],
      })
      .mockResolvedValueOnce({
        tools: null,
        budgetExceeded: [],
        unreachable: [{ serverId: "mcp-1", url: "http://localhost:7769/mcp", message: "connection refused" }],
      });
    renderTab();

    expect(clearMcpCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());
    // the button itself must clear the module-level tool cache before every
    // check, not just on server add/remove/toggle -- otherwise a second
    // press could report a stale cached result instead of re-discovering.
    expect(clearMcpCache).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Check tool budget"));
    // the server that succeeded on the first check is now correctly
    // reported unreachable on the second, not masked by a stale success.
    await waitFor(() => expect(screen.getByText(/unreachable/i)).toBeInTheDocument());
    expect(clearMcpCache).toHaveBeenCalledTimes(2);
  });

  it("clears the stale tool-budget summary when a server is removed", async () => {
    vi.mocked(assembleTools).mockResolvedValueOnce({
      tools: [{ server_id: "mcp-1", name: "t", url: "u", endpoint: "e", description: "d", input_schema: {} }] as any,
      budgetExceeded: [],
      unreachable: [],
    });
    renderTab();
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));
    expect(clearMcpCache).toHaveBeenCalled();
    expect(screen.queryByText(/tool\(s\) available/i)).not.toBeInTheDocument();
  });

  // --- Part B, review finding 1: before the tab split, SettingsDialog reset
  // both the draft and the MCP budget-check result whenever the store's
  // settings changed while the dialog was open. The draft reset survived
  // the split (SettingsDialog's own effect); this half didn't, because
  // mcpCheck now lives here. ---

  it("clears the stale tool-budget summary when the settings prop changes out from under it", async () => {
    vi.mocked(assembleTools).mockResolvedValueOnce({
      tools: [{ server_id: "mcp-1", name: "t", url: "u", endpoint: "e", description: "d", input_schema: {} }] as any,
      budgetExceeded: [],
      unreachable: [],
    });
    const { rerender } = renderTab();
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());

    // Settings changed out from under the open dialog (e.g. reload from
    // disk) while this tab was showing a budget-check result computed
    // against the pre-reset server list.
    rerender({
      ...baseSettings,
      mcpServers: [{ id: "mcp-2", url: "http://localhost:7770/mcp", enabled: true }],
    });

    expect(screen.queryByText(/tool\(s\) available/i)).not.toBeInTheDocument();
  });
});
