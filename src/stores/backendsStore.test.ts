import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../lib/types";

const loadBackends = vi.fn(async (): Promise<BackendConfig[]> => []);
const saveBackends = vi.fn(async (_b: BackendConfig[]) => {});

// The store must fall back to persistence's defaults, not keep its own copy —
// a second copy previously diverged on `id`, which silently broke
// card-to-backend resolution since DashboardCard.backendId matches on it.
const DEFAULT_BACKENDS: BackendConfig[] = [
  { id: "nas", name: "OpenBB NAS", baseUrl: "https://example.test" },
];

vi.mock("../lib/persistence", () => ({
  loadBackends: (...a: []) => loadBackends(...a),
  saveBackends: (b: BackendConfig[]) => saveBackends(b),
  get DEFAULT_BACKENDS() { return DEFAULT_BACKENDS; },
}));

import { useBackendsStore } from "./backendsStore";

beforeEach(() => {
  vi.resetAllMocks();
  // Reset persistence storage by mocking loadBackends to return empty array
  // This ensures tests don't see data from previous tests during hydration
  vi.mocked(loadBackends).mockResolvedValue([]);
});

describe("useBackendsStore", () => {
  it("default state has empty backends array", () => {
    const state = useBackendsStore.getState();
    expect(state.backends).toEqual([]);
  });

  it("load() returns default backend when persistence is empty", async () => {
    loadBackends.mockResolvedValueOnce([]);
    await useBackendsStore.getState().load();
    const state = useBackendsStore.getState();
    expect(state.backends).toHaveLength(1);
    expect(state.backends).toEqual(DEFAULT_BACKENDS);
  });

  it("load() returns persisted backends when available", async () => {
    const backends: BackendConfig[] = [
      { id: "custom", name: "Custom", baseUrl: "http://localhost:8000" },
    ];
    loadBackends.mockResolvedValueOnce(backends);
    await useBackendsStore.getState().load();
    const state = useBackendsStore.getState();
    expect(state.backends).toEqual(backends);
  });

  it("addBackend adds to backends and persists", async () => {
    // Clear store state before test (this will trigger persistence, but we'll account for it)
    useBackendsStore.setState({ backends: [] });
    
    const backend: BackendConfig = {
      id: "new-backend",
      name: "New Backend",
      baseUrl: "http://localhost:8001",
    };
    await useBackendsStore.getState().addBackend(backend);
    const state = useBackendsStore.getState();
    expect(state.backends).toHaveLength(1);
    expect(state.backends).toContainEqual(backend);
    expect(saveBackends).toHaveBeenCalledTimes(1); // 1 from addBackend
  });

  it("removeBackend removes backend and persists", async () => {
    // Start with empty state
    useBackendsStore.setState({ backends: [] });
    
    const backend: BackendConfig = {
      id: "to-remove",
      name: "To Remove",
      baseUrl: "http://localhost:8000",
    };
    await useBackendsStore.getState().addBackend(backend);
    await useBackendsStore.getState().removeBackend("to-remove");
    const state = useBackendsStore.getState();
    expect(state.backends).toHaveLength(0);
    expect(saveBackends).toHaveBeenCalledTimes(2); // 1 from addBackend, 1 from removeBackend
  });

  it("updateBackend patches backend and persists", async () => {
    // Start with empty state
    useBackendsStore.setState({ backends: [] });
    
    const backend: BackendConfig = {
      id: "update-me",
      name: "Original",
      baseUrl: "http://localhost:8000",
    };
    await useBackendsStore.getState().addBackend(backend);
    await useBackendsStore.getState().updateBackend("update-me", {
      name: "Updated",
    });
    const state = useBackendsStore.getState();
    expect(state.backends[0].name).toBe("Updated");
    expect(state.backends[0].baseUrl).toBe("http://localhost:8000");
    expect(saveBackends).toHaveBeenCalledTimes(2); // 1 from addBackend, 1 from updateBackend
  });

  it("setBackends replaces all backends and persists", async () => {
    // Start with empty state
    useBackendsStore.setState({ backends: [] });
    
    const backends: BackendConfig[] = [
      { id: "a", name: "A", baseUrl: "http://a" },
      { id: "b", name: "B", baseUrl: "http://b" },
    ];
    await useBackendsStore.getState().setBackends(backends);
    const state = useBackendsStore.getState();
    expect(state.backends).toEqual(backends);
    expect(saveBackends).toHaveBeenCalledTimes(1); // 1 from setBackends
  });
});
