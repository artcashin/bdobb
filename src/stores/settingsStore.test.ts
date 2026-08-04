import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig, Settings } from "../lib/types";

const loadSettings = vi.fn(async (): Promise<Settings> => ({
  ritaUrl: "",
  theme: "dark",
  contextSharing: false,
  mcpServers: [],
}));
const saveSettings = vi.fn(async (_s: Settings) => {});

vi.mock("../lib/persistence", () => ({
  DEFAULT_SETTINGS: { ritaUrl: "", theme: "dark", contextSharing: false, mcpServers: [] },
  loadSettings: (...a: []) => loadSettings(...a),
  saveSettings: (s: Settings) => saveSettings(s),
}));

import { useSettingsStore } from "./settingsStore";

beforeEach(() => {
  vi.clearAllMocks();
  // Note: we don't reset state here because:
  // - setState on a persisted store triggers persistence
  // - Tests are self-contained and don't depend on previous state
  // - But we need to clear persistence mocks so tests don't see old data
});

describe("useSettingsStore", () => {
  it("initial state matches Settings type", () => {
    const state = useSettingsStore.getState();
    expect(state.settings).toEqual({
      ritaUrl: "",
      theme: "dark",
      contextSharing: false,
      mcpServers: [],
    });
  });

  it("setRitaUrl updates and persists settings", async () => {
    await useSettingsStore.getState().setRitaUrl("http://localhost:8002");
    const state = useSettingsStore.getState();
    expect(state.settings.ritaUrl).toBe("http://localhost:8002");
    expect(saveSettings).toHaveBeenCalledTimes(1); // Only from setRitaUrl action
  });

  it("setContextSharing updates and persists settings", async () => {
    await useSettingsStore.getState().setContextSharing(true);
    const state = useSettingsStore.getState();
    expect(state.settings.contextSharing).toBe(true);
    expect(saveSettings).toHaveBeenCalledTimes(1); // Only from setContextSharing action
  });

  it("setMcpServers updates and persists settings", async () => {
    const servers: McpServerConfig[] = [
      { id: "mcp1", url: "http://localhost:7769/mcp", enabled: true },
    ];
    await useSettingsStore.getState().setMcpServers(servers);
    const state = useSettingsStore.getState();
    expect(state.settings.mcpServers).toEqual(servers);
    expect(saveSettings).toHaveBeenCalledTimes(1); // Only from setMcpServers action
  });

  it("load() populates state from persistence", async () => {
    loadSettings.mockResolvedValueOnce({
      ritaUrl: "http://rita.local",
      theme: "dark",
      contextSharing: true,
      mcpServers: [],
    });
    await useSettingsStore.getState().load();
    const state = useSettingsStore.getState();
    expect(state.settings).toEqual({
      ritaUrl: "http://rita.local",
      theme: "dark",
      contextSharing: true,
      mcpServers: [],
    });
  });

  // Grafted from desk (358e463): settingsStore gained a `loadError` field so
  // a failed load's reason survives past the initial `logError` call for a
  // future UI (SettingsDialog, Task 18) to explain itself with. bdobb's
  // store keeps DEFAULT_SETTINGS as a non-null fallback (desk's `settings`
  // is nullable instead), so this is purely additive: `load()` already
  // rethrew nothing before -- errors propagated -- this only ALSO records
  // the reason.
  describe("loadError", () => {
    it("initial state has no loadError", () => {
      expect(useSettingsStore.getState().loadError).toBeNull();
    });

    it("load() records the reason and rethrows on failure", async () => {
      loadSettings.mockRejectedValueOnce(new Error("permission denied"));
      await expect(useSettingsStore.getState().load()).rejects.toThrow("permission denied");
      expect(useSettingsStore.getState().loadError).toBe("permission denied");
    });

    it("a successful load clears a prior loadError", async () => {
      loadSettings.mockRejectedValueOnce(new Error("disk full"));
      await expect(useSettingsStore.getState().load()).rejects.toThrow();
      expect(useSettingsStore.getState().loadError).toBeTruthy();

      loadSettings.mockResolvedValueOnce({
        ritaUrl: "", theme: "dark", contextSharing: false, mcpServers: [],
      });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().loadError).toBeNull();
    });
  });
});
