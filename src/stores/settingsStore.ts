import { create } from "zustand";
import type { Settings } from "../lib/types";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/persistence";

interface SettingsState {
  settings: Settings;
  /**
   * The reason `load()` last failed, if any (e.g. `ensureDirs()`'s `mkdir`
   * failing on a permissions/full-disk/sandbox error in persistence.ts).
   * App.tsx's startup effect only logs a failed `load()` -- it never
   * surfaces WHY to the UI -- so a future SettingsDialog can read this to
   * explain itself instead of silently showing defaults with no
   * explanation. `settings` itself stays the last-known-good value (or
   * `DEFAULT_SETTINGS`) on failure; this field only records that the load
   * didn't actually happen.
   */
  loadError: string | null;
  setRitaUrl(url: string): Promise<void>;
  setContextSharing(enabled: boolean): Promise<void>;
  setMcpServers(servers: Settings["mcpServers"]): Promise<void>;
  setShareTargets(targets: NonNullable<Settings["shareTargets"]>): Promise<void>;
  /** Applies several fields in one write; four separate setters raced. */
  update(patch: Partial<Settings>): Promise<void>;
  load(): Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  (set, get) => ({
    settings: DEFAULT_SETTINGS,
    loadError: null,
    async setRitaUrl(url) {
      const next = { ...get().settings, ritaUrl: url };
      set({ settings: next });
      await saveSettings(next);
    },
    async setContextSharing(enabled) {
      const next = { ...get().settings, contextSharing: enabled };
      set({ settings: next });
      await saveSettings(next);
    },
    async setMcpServers(servers) {
      const next = { ...get().settings, mcpServers: servers };
      set({ settings: next });
      await saveSettings(next);
    },
    async setShareTargets(targets) {
      const next = { ...get().settings, shareTargets: targets };
      set({ settings: next });
      await saveSettings(next);
    },
    async update(patch) {
      const next = { ...get().settings, ...patch };
      set({ settings: next });
      await saveSettings(next);
    },
    async load() {
      try {
        set({ settings: await loadSettings(), loadError: null });
      } catch (e) {
        // Rethrown unchanged -- App.tsx's existing try/catch + `logError`
        // behavior for a failed startup load is untouched. This only ADDS a
        // visible reason for the UI to read, it doesn't change control flow.
        set({ loadError: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  })
);
