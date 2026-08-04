import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../lib/types";

vi.mock("../lib/persistence", () => ({
  DEFAULT_SETTINGS: { theme: "dark" },
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

import { loadSettings, saveSettings } from "../lib/persistence";
import { useSettingsStore } from "./settingsStore";

describe("settingsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      settings: { theme: "dark" },
      loadError: null,
    });
  });

  it("update applies a patch in one write", async () => {
    vi.mocked(saveSettings).mockResolvedValue(undefined);
    await useSettingsStore.getState().update({ theme: "dark" });
    expect(useSettingsStore.getState().settings.theme).toBe("dark");
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("load replaces settings from disk and clears loadError", async () => {
    const fromDisk: Settings = { theme: "dark" };
    vi.mocked(loadSettings).mockResolvedValue(fromDisk);
    useSettingsStore.setState({ loadError: "old failure" });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().settings).toEqual(fromDisk);
    expect(useSettingsStore.getState().loadError).toBeNull();
  });

  it("a failed load records the reason, keeps last-known settings, and rethrows", async () => {
    vi.mocked(loadSettings).mockRejectedValue(new Error("mkdir failed"));
    const before = useSettingsStore.getState().settings;
    await expect(useSettingsStore.getState().load()).rejects.toThrow("mkdir failed");
    expect(useSettingsStore.getState().settings).toBe(before);
    expect(useSettingsStore.getState().loadError).toBe("mkdir failed");
  });
});
