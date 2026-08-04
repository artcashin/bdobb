import { create } from "zustand";
import type { BackendConfig, WidgetDef } from "../lib/types";
import { fetchWidgetsJson } from "../lib/dataClient";
import { logError } from "../lib/logger";

export type BackendStatus = "online" | "offline";

interface RegistryState {
  widgets: WidgetDef[];
  /**
   * Per-backend reachability from the last discovery. Runtime only — writing
   * it into backends.json meant one transient failure at launch was persisted
   * as "offline" forever.
   */
  status: Record<string, BackendStatus>;
  /** True while discovery is in flight, so the library can say so. */
  loading: boolean;
  setWidgets(widgets: WidgetDef[]): void;
  addWidget(widget: WidgetDef): void;
  removeWidget(widgetId: string): void;
  clearWidgets(): void;
  find(backendId: string, widgetId: string): WidgetDef | undefined;
  loadFromBackend(backendId: string, backend: BackendConfig): Promise<void>;
  refresh(backends: BackendConfig[]): Promise<void>;
}

export const useRegistryStore = create<RegistryState>((set, get) => {
  // Guards against a slower, earlier refresh() overwriting a newer one's
  // results after both were kicked off concurrently -- e.g. the startup
  // discovery is still in flight when the user hits "Refresh" in
  // BackendsDialog right after adding a backend. Only the most recently
  // STARTED call's results are ever committed; an outdated call's results
  // are discarded when it finally resolves instead of clobbering whatever
  // the newer call already found (or is about to find).
  let generation = 0;
  // Tracks how many refresh() calls are currently in flight so an
  // overlapping fast refresh can't clear `loading` while a slower one
  // (whose results may still be discarded above) is still running.
  let inFlight = 0;

  return {
    widgets: [],
    status: {},
    loading: false,
    setWidgets(widgets) {
      set({ widgets });
    },
    addWidget(widget) {
      set({ widgets: [...get().widgets, widget] });
    },
    removeWidget(widgetId) {
      set({ widgets: get().widgets.filter((w) => w.id !== widgetId) });
    },
    clearWidgets() {
      set({ widgets: [] });
    },
    find(backendId, widgetId) {
      return get().widgets.find((w) => w.id === widgetId && w.backendId === backendId);
    },
    async loadFromBackend(backendId, backend) {
      const widgets = await fetchWidgetsJson(backend);
      set({ widgets: widgets.map((w) => ({ ...w, backendId })) });
    },
    async refresh(backends) {
      const myGeneration = ++generation;
      inFlight++;
      set({ loading: true });
      try {
        // Snapshot before awaiting: used below to keep a backend's last-known
        // widgets on a transient failure instead of blanking it out of the
        // library on one bad fetch.
        const priorWidgets = get().widgets;

        // Concurrent, not serial: one backend hanging on a TCP timeout must
        // not block discovery of every other backend.
        const results = await Promise.allSettled(
          backends.map(async (backend) => {
            const widgets = await fetchWidgetsJson(backend);
            return widgets.map((w) => ({ ...w, backendId: backend.id }));
          })
        );

        if (myGeneration !== generation) {
          // A newer refresh() started while this one was still in flight.
          // Its backend list may already be stale (a backend could have
          // been added or removed since), so committing these results could
          // resurrect a removed backend's widgets or clobber what the newer
          // call already found.
          return;
        }

        const allWidgets: WidgetDef[] = [];
        const status: Record<string, BackendStatus> = {};
        results.forEach((r, i) => {
          const backend = backends[i];
          if (r.status === "fulfilled") {
            allWidgets.push(...r.value);
            status[backend.id] = "online";
          } else {
            logError(`Failed to load widgets from backend ${backend.id}: ${String(r.reason)}`);
            status[backend.id] = "offline";
            // Keep whatever we already had for this backend instead of a
            // transient failure blanking its widgets out of the library.
            allWidgets.push(...priorWidgets.filter((w) => w.backendId === backend.id));
          }
        });

        set({ widgets: allWidgets, status });
      } finally {
        inFlight--;
        if (inFlight === 0) set({ loading: false });
      }
    },
  };
});
