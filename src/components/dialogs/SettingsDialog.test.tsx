import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import SettingsDialog, { type SettingsDialogProps } from "./SettingsDialog";
import { useSettingsStore } from "../../stores/settingsStore";
import { readLogTail } from "../../lib/logger";

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
  symphonyPodUrl: "https://my-pod.symphony.com",
  symphonyPartnerId: "partner-9",
  symphonyBridgeUrl: "http://localhost:9100",
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

  // Carried from the log-viewer suite: whether the log is read at all is
  // gated by the dialog's isOpen/Modal wrapper, not by anything a tab
  // component can express on its own (LogsTab always loads on mount), so
  // this case stays here rather than moving with the rest of the log tests.
  it("does not read the log when the dialog is closed (avoids log I/O on every app launch)", () => {
    render(<SettingsDialog isOpen={false} onClose={() => {}} />);
    expect(readLogTail).not.toHaveBeenCalled();
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
    it("shows five tabs and opens on Rita", async () => {
      await renderOpen();
      const tabs = screen.getAllByRole("tab");
      expect(tabs.map((t) => t.textContent)).toEqual([
        "Rita", "MCP", "Appearance", "Symphony", "Logs",
      ]);
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
      fireEvent.keyDown(screen.getByRole("tab", { name: "Logs" }), { key: "ArrowLeft" });
      expect(screen.getByRole("tab", { name: "Symphony" })).toHaveAttribute("aria-selected", "true");
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

  describe("Symphony tab", () => {
    it("shows the three Symphony fields with their current values", async () => {
      await renderOpen();
      fireEvent.click(screen.getByRole("tab", { name: "Symphony" }));
      expect(screen.getByLabelText("Pod URL")).toHaveValue("https://my-pod.symphony.com");
      expect(screen.getByLabelText("Partner ID")).toHaveValue("partner-9");
      expect(screen.getByLabelText("Bridge URL")).toHaveValue("http://localhost:9100");
    });

    it("saves edits made on the Symphony tab", async () => {
      await renderOpen();
      fireEvent.click(screen.getByRole("tab", { name: "Symphony" }));
      fireEvent.change(screen.getByLabelText("Pod URL"), {
        target: { value: "https://new-pod.symphony.com" },
      });
      fireEvent.change(screen.getByLabelText("Partner ID"), {
        target: { value: "partner-42" },
      });
      fireEvent.change(screen.getByLabelText("Bridge URL"), {
        target: { value: "http://localhost:9200" },
      });
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({
            symphonyPodUrl: "https://new-pod.symphony.com",
            symphonyPartnerId: "partner-42",
            symphonyBridgeUrl: "http://localhost:9200",
          })
        )
      );
    });

    it("rejects an invalid Symphony pod URL on save", async () => {
      const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
      await renderOpen();
      fireEvent.click(screen.getByRole("tab", { name: "Symphony" }));
      fireEvent.change(screen.getByLabelText("Pod URL"), { target: { value: "not a url" } });
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("Symphony pod"))
      );
      expect(update).not.toHaveBeenCalled();
      alertMock.mockRestore();
    });

    it("rejects an invalid Symphony bridge URL on save", async () => {
      const alertMock = vi.spyOn(window, "alert").mockImplementation(() => {});
      await renderOpen();
      fireEvent.click(screen.getByRole("tab", { name: "Symphony" }));
      fireEvent.change(screen.getByLabelText("Bridge URL"), { target: { value: "not a url" } });
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("Symphony bridge"))
      );
      expect(update).not.toHaveBeenCalled();
      alertMock.mockRestore();
    });

    it("allows saving with the pod and bridge URLs left empty (both optional)", async () => {
      setStoreState({
        settings: { ...baseSettings, symphonyPodUrl: "", symphonyBridgeUrl: "" },
      });
      await renderOpen();
      fireEvent.click(screen.getByText("Save Settings"));
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({ symphonyPodUrl: "", symphonyBridgeUrl: "" })
        )
      );
    });
  });
});
