import { create } from "zustand";
import type { BackendConfig } from "../lib/types";
import { loadBackends, saveBackends, DEFAULT_BACKENDS } from "../lib/persistence";

interface BackendsState {
  backends: BackendConfig[];
  addBackend(backend: BackendConfig): Promise<void>;
  removeBackend(id: string): Promise<void>;
  updateBackend(id: string, patch: Partial<BackendConfig>): Promise<void>;
  setBackends(backends: BackendConfig[]): Promise<void>;
  load(): Promise<void>;
}

// Single source of truth: a second copy here previously seeded id "default"
// while persistence seeded "nas". DashboardCard.backendId is matched against
// these, so the mismatch silently broke card-to-backend resolution.

export const useBackendsStore = create<BackendsState>()(
  (set, get) => ({
    backends: [],
    async addBackend(backend) {
      const next = [...get().backends, backend];
      set({ backends: next });
      await saveBackends(next);
    },
    async removeBackend(id) {
      const next = get().backends.filter((b) => b.id !== id);
      set({ backends: next });
      await saveBackends(next);
    },
    async updateBackend(id, patch) {
      const next = get().backends.map((b) =>
        b.id === id ? { ...b, ...patch } : b
      );
      set({ backends: next });
      await saveBackends(next);
    },
    async setBackends(backends) {
      set({ backends });
      await saveBackends(backends);
    },
    async load() {
      const backends = await loadBackends();
      set({ backends: backends.length > 0 ? backends : DEFAULT_BACKENDS });
    },
  })
);
