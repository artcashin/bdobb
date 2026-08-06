import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import McpTab from "./McpTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";
import { assembleTools } from "../../../lib/agent/mcp";

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

function renderTab(settings = baseSettings) {
  const onChange = vi.fn();
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

  // Part B, review finding 1: before the tab split, SettingsDialog reset
  // both the draft and the MCP budget-check result whenever the store's
  // settings changed while the dialog was open. The draft reset survived
  // the split (SettingsDialog's own effect); this half didn't, because
  // mcpCheck now lives here.
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
