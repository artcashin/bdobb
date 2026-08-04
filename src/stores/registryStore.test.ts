import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, WidgetDef } from "../lib/types";

const fetchWidgetsJson = vi.fn();
vi.mock("../lib/dataClient", () => ({
  fetchWidgetsJson: (b: BackendConfig) => fetchWidgetsJson(b),
}));
vi.mock("../lib/logger", () => ({
  logError: vi.fn(),
}));

import { useRegistryStore } from "./registryStore";

const widget = { id: "w1", name: "W1" , backendId: "test" } as WidgetDef;

beforeEach(() => {
  vi.clearAllMocks();
  useRegistryStore.setState({ widgets: [], status: {}, loading: false });
});

describe("useRegistryStore", () => {
  it("initial state has empty widgets array", () => {
    expect(useRegistryStore.getState().widgets).toEqual([]);
  });

  it("setWidgets replaces widgets", () => {
    useRegistryStore.getState().setWidgets([widget]);
    expect(useRegistryStore.getState().widgets).toEqual([widget]);
  });

  it("addWidget appends to widgets", () => {
    useRegistryStore.getState().addWidget(widget);
    expect(useRegistryStore.getState().widgets).toEqual([widget]);
  });

  it("removeWidget removes widget by id", () => {
    useRegistryStore.getState().setWidgets([widget, { ...widget, id: "w2" }]);
    useRegistryStore.getState().removeWidget("w1");
    expect(useRegistryStore.getState().widgets).toEqual([{ ...widget, id: "w2" }]);
  });

  it("clearWidgets empties the array", () => {
    useRegistryStore.getState().setWidgets([widget]);
    useRegistryStore.getState().clearWidgets();
    expect(useRegistryStore.getState().widgets).toEqual([]);
  });

  it("loadFromBackend fetches widgets from backend", async () => {
    const backend = { id: "nas", baseUrl: "", name: "" };
    fetchWidgetsJson.mockResolvedValueOnce([widget]);
    await useRegistryStore.getState().loadFromBackend("nas", backend);
    expect(useRegistryStore.getState().widgets).toEqual([{ ...widget, backendId: "nas" }]);
    expect(fetchWidgetsJson).toHaveBeenCalledWith(backend);
  });

  // Grafted from desk (registryStore.test.ts), adapted to bdobb's flat
  // `widgets: WidgetDef[]` + self-owned `status` shape -- desk's design uses
  // `widgets: Record<backendId, WidgetDef[]>` with status living on
  // backendsStore, which WidgetLibrary.tsx and BackendsDialog.tsx (both out
  // of this task's scope) don't consume. The underlying behaviors --
  // per-backend status, keeping stale widgets across a transient failure,
  // and surviving overlapping refresh() calls without clobbering -- are
  // ported as first-class refresh() coverage, since qwen's own suite had
  // none at all before this merge.
  describe("refresh", () => {
    const nas: BackendConfig = { id: "nas", name: "OpenBB NAS", baseUrl: "https://example.test" };

    it("stores widgets tagged with backendId and marks it online", async () => {
      fetchWidgetsJson.mockResolvedValueOnce([widget]);
      await useRegistryStore.getState().refresh([nas]);
      expect(useRegistryStore.getState().widgets).toEqual([{ ...widget, backendId: "nas" }]);
      expect(useRegistryStore.getState().find("nas", "w1")).toEqual({ ...widget, backendId: "nas" });
      expect(useRegistryStore.getState().status.nas).toBe("online");
      expect(useRegistryStore.getState().loading).toBe(false);
    });

    it("marks the backend offline on failure and keeps its prior widgets", async () => {
      useRegistryStore.setState({ widgets: [{ ...widget, backendId: "nas" }] });
      fetchWidgetsJson.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await useRegistryStore.getState().refresh([nas]);
      expect(useRegistryStore.getState().status.nas).toBe("offline");
      expect(useRegistryStore.getState().widgets).toEqual([{ ...widget, backendId: "nas" }]); // stale kept
      expect(useRegistryStore.getState().loading).toBe(false);
    });

    it("an earlier, slower refresh completing after a newer one does not clobber the newer results", async () => {
      const widgetOld = { id: "old", name: "Old", backendId: "nas" } as WidgetDef;
      const widgetNew = { id: "new", name: "New", backendId: "nas" } as WidgetDef;

      // The first call's fetch resolves only after the second call has
      // already started and finished -- simulating a slow startup refresh
      // overlapping a fast manual "Refresh" click.
      let resolveFirst!: (v: WidgetDef[]) => void;
      fetchWidgetsJson.mockImplementationOnce(
        () => new Promise((res) => { resolveFirst = res; })
      );
      fetchWidgetsJson.mockResolvedValueOnce([widgetNew]);

      const refreshFirst = useRegistryStore.getState().refresh([nas]);
      const refreshSecond = useRegistryStore.getState().refresh([nas]);
      await refreshSecond;
      expect(useRegistryStore.getState().widgets).toEqual([{ ...widgetNew, backendId: "nas" }]);
      // loading must still be true: the first refresh is still outstanding.
      expect(useRegistryStore.getState().loading).toBe(true);

      resolveFirst([widgetOld]);
      await refreshFirst;
      // The stale first call's results were discarded, not merged in.
      expect(useRegistryStore.getState().widgets).toEqual([{ ...widgetNew, backendId: "nas" }]);
      expect(useRegistryStore.getState().loading).toBe(false);
    });
  });
});
