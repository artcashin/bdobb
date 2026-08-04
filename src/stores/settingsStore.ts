import { create } from "zustand";
import type { Settings } from "../lib/types";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../lib/persistence";

interface SettingsState {
  settings: Settings;
  /**
   * The reason `load()` last failed, if any (e.g. `ensureDirs()`'s `mkdir`
   * failing on a permissions/full-disk/sandbox error in persistence.ts).
   * The settings dialog reads this to explain itself instead of silently
   * showing defaults. `settings` itself stays the last-known-good value (or
   * `DEFAULT_SETTINGS`) on failure; this field only records that the load
   * didn't actually happen.
   */
  loadError: string | null;
  /** Applies several fields in one write; separate setters raced. */
  update(patch: Partial<Settings>): Promise<void>;
  load(): Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  (set, get) => ({
    settings: DEFAULT_SETTINGS,
    loadError: null,
    async update(patch) {
      const next = { ...get().settings, ...patch };
      set({ settings: next });
      await saveSettings(next);
    },
    async load() {
      try {
        set({ settings: await loadSettings(), loadError: null });
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
  })
);
