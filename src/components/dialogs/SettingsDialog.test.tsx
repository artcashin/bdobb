import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SettingsDialog, { type SettingsDialogProps } from "./SettingsDialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { readLogTail } from "../../lib/logger";
import { assembleTools, clearMcpCache } from "../../lib/agent/mcp";

vi.mock("../Modal", () => ({
  default: ({ isOpen, onClose, title, children, footer }: any) =>
    isOpen ? (
      <div data-testid="mock-modal">
        <h2>{title}</h2>
        <div>{children}</div>
        {footer && <div data-testid="mock-footer">{footer}</div>}
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

const baseSettings = {
  ritaUrl: "http://localhost:8002",
  theme: "dark" as const,
  contextSharing: true,
  mcpServers: [{ id: "mcp-1", url: "http://localhost:7769/mcp", enabled: true }],
  shareTargets: [],
};

const update = vi.fn(async () => {});

vi.mock("../../stores/settingsStore", () => {
  const useSettingsStore = vi.fn((selector: any) =>
    selector({
      settings: (useSettingsStore as any).__settings,
      loadError: (useSettingsStore as any).__loadError,
      update: (useSettingsStore as any).__update,
    })
  );
  return { useSettingsStore, __esModule: true };
});

// Logger and MCP are mocked so the log viewer and "Check tool budget" panels
// (carried requirements 1 and 3) are deterministic instead of hitting a
// missing Tauri IPC bridge in jsdom.
vi.mock("../../lib/logger", () => ({
  logError: vi.fn(),
  getLogPath: vi.fn(async () => "/Users/test/Library/logs/bdobb.log"),
  readLogTail: vi.fn(async () => ["2026-08-04T00:00:00Z [INFO] sample line"]),
}));

vi.mock("../../lib/agent/mcp", () => ({
  assembleTools: vi.fn(async () => ({ tools: null, budgetExceeded: [], unreachable: [] })),
  clearMcpCache: vi.fn(),
}));

function setStoreState(overrides: { settings?: any; loadError?: string | null } = {}) {
  const mod: any = useSettingsStore;
  mod.__settings = overrides.settings ?? baseSettings;
  mod.__loadError = overrides.loadError ?? null;
  mod.__update = update;
}

/**
 * Renders the open dialog. The dialog opens on the Rita tab, which has no
 * pending effects of its own, so there is nothing to await here -- unlike
 * before the tab split, the log-load effect no longer fires on open; it
 * fires only once the Logs tab mounts (see the log-viewer tests below).
 */
async function renderOpen(props: Partial<SettingsDialogProps> = {}) {
  return render(<SettingsDialog isOpen={true} onClose={() => {}} {...props} />);
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockReset().mockResolvedValue(undefined);
    setStoreState();
  });

  it("renders dialog when open", async () => {
    await renderOpen();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://localhost:8002")).toBeInTheDocument();
  });

  it("renders Rita URL input", async () => {
    await renderOpen();
    expect(screen.getByDisplayValue("http://localhost:8002")).toBeInTheDocument();
    expect(screen.getByText("Rita URL")).toBeInTheDocument();
  });

  it("renders context sharing toggle", async () => {
    await renderOpen();
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeInTheDocument();
  });

  it("renders MCP servers list", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:7769/mcp")).toBeInTheDocument();
  });

  it("renders theme section with dark only", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    // "Appearance" now also labels the tab button, so scope to the section heading.
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Dark (v1)")).toBeInTheDocument();
  });

  // --- Carried requirement 1: log viewer (readLogTail/getLogPath), ported
  // from desk's dialogs.test.tsx and adapted to qwen's isOpen-gated mount.
  // Now that the log viewer lives in its own tab, these load the log by
  // switching to the Logs tab rather than by opening the dialog. ---

  it("shows the log path and tail when opened", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(screen.getByText(/sample line/)).toBeInTheDocument());
    expect(screen.getByText("/Users/test/Library/logs/bdobb.log")).toBeInTheDocument();
  });

  it("does not read the log when the dialog is closed (avoids log I/O on every app launch)", () => {
    render(<SettingsDialog isOpen={false} onClose={() => {}} />);
    expect(readLogTail).not.toHaveBeenCalled();
  });

  it("surfaces a log-read failure instead of swallowing it", async () => {
    vi.mocked(readLogTail).mockRejectedValueOnce(new Error("no such file or directory"));
    render(<SettingsDialog isOpen={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() =>
      expect(screen.getByText(/Failed to read log.*no such file/i)).toBeInTheDocument()
    );
  });

  it("reloads the log on demand", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    await waitFor(() => expect(readLogTail).toHaveBeenCalledTimes(1));
    vi.mocked(readLogTail).mockResolvedValueOnce(["a fresh line"]);
    fireEvent.click(screen.getByText("Reload log"));
    await waitFor(() => expect(screen.getByText(/a fresh line/)).toBeInTheDocument());
  });

  it("disables Add and warns when the new MCP server URL is not a valid http(s) URL", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
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
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());
  });

  it("marks a server whose MCP discovery failed instead of giving a false all-clear", async () => {
    vi.mocked(assembleTools).mockResolvedValueOnce({
      tools: null,
      budgetExceeded: [],
      unreachable: [{ serverId: "mcp-1", url: "http://localhost:7769/mcp", message: "connection refused" }],
    });
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
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
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));

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
    await renderOpen();
    fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
    fireEvent.click(screen.getByText("Check tool budget"));
    await waitFor(() => expect(screen.getByText(/tool\(s\) available/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText("Remove"));
    expect(clearMcpCache).toHaveBeenCalled();
    expect(screen.queryByText(/tool\(s\) available/i)).not.toBeInTheDocument();
  });

  // --- Load-error visibility (spirit of desk's blank-render fix: qwen's
  // `settings` is never null -- it falls back to DEFAULT_SETTINGS -- so
  // there is no blank-render bug to fix, but a real load failure was
  // previously invisible; settingsStore.loadError (Task 11) is now read). ---

  it("shows a banner when settings failed to load from disk, without blocking the rest of the dialog", async () => {
    setStoreState({ loadError: "failed to create app-data directories: EACCES" });
    await renderOpen();
    expect(screen.getByText(/could not be loaded from disk/i)).toBeInTheDocument();
    expect(screen.getByText(/EACCES/)).toBeInTheDocument();
    // the rest of the dialog still renders and is usable
    expect(screen.getByDisplayValue("http://localhost:8002")).toBeInTheDocument();
  });

  it("shows an alert when saving fails instead of silently discarding the edit", async () => {
    const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
    update.mockRejectedValueOnce(new Error("disk full"));
    await renderOpen();
    fireEvent.click(screen.getByText("Save Settings"));
    await waitFor(() =>
      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("disk full"))
    );
    alertMock.mockRestore();
  });

  describe("tabs", () => {
    it("shows four tabs and opens on Rita", async () => {
      await renderOpen();
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual(["Rita", "MCP", "Appearance", "Logs"]);
      expect(screen.getByRole("tab", { name: "Rita" })).toHaveAttribute("aria-selected", "true");
    });

    it("swaps the panel when another tab is clicked", async () => {
      await renderOpen();
      // The Rita URL field is on the Rita tab; MCP's add-server field is not.
      expect(screen.getByLabelText("Rita URL")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
      expect(screen.queryByLabelText("Rita URL")).not.toBeInTheDocument();
      expect(screen.getByLabelText("New MCP server URL")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    });

    it("keeps an edit made on one tab when another tab is visited", async () => {
      // The whole risk of this refactor: a tab unmounting must not drop a
      // draft edit, because Save writes the draft, not the DOM.
      await renderOpen();
      fireEvent.change(screen.getByLabelText("Rita URL"), {
        target: { value: "http://localhost:9999" },
      });
      fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
      await waitFor(() => expect(readLogTail).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("tab", { name: "Rita" }));
      expect(screen.getByLabelText("Rita URL")).toHaveValue("http://localhost:9999");
    });

    it("saves an edit made on a tab that is not the active one", async () => {
      await renderOpen();
      fireEvent.change(screen.getByLabelText("Rita URL"), {
        target: { value: "http://localhost:9999" },
      });
      fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({ ritaUrl: "http://localhost:9999" })
        )
      );
    });

    it("moves between tabs with arrow keys", async () => {
      await renderOpen();
      const rita = screen.getByRole("tab", { name: "Rita" });
      rita.focus();
      fireEvent.keyDown(rita, { key: "ArrowRight" });
      expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(screen.getByRole("tab", { name: "MCP" }), { key: "End" });
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
      // Landing on Logs mounts its async load effect; let it settle so the
      // test doesn't finish with a state update outside of act().
      await waitFor(() => expect(readLogTail).toHaveBeenCalled());
    });

    it("shows the load-error banner on every tab", async () => {
      setStoreState({ loadError: "settings.json is corrupt" });
      await renderOpen();
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "MCP" }));
      expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    });
  });
});
