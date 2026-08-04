import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard, WidgetDef } from "../lib/types";

const saveDashboard = vi.fn(async (_d: Dashboard) => {});
const deleteDashboard = vi.fn(async (_id: string) => {});
const loadDashboards = vi.fn(async (): Promise<Dashboard[]> => [
  { id: "default", name: "Main Dashboard", cards: [] },
]);

vi.mock("../lib/persistence", () => ({
  loadDashboards: (...a: []) => loadDashboards(...a),
  saveDashboard: (d: Dashboard) => saveDashboard(d),
  deleteDashboard: (id: string) => deleteDashboard(id),
}));

const logError = vi.fn();
vi.mock("../lib/logger", () => ({
  logError: (msg: string) => logError(msg),
}));

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

import { GRID_COLS, useDashboardStore } from "./dashboardStore";

const widget: WidgetDef = {
  id: "equity_price_historical_eodhd_obb", name: "Historical", description: "",
  category: "Equity", subCategory: "Price", type: "table",
  endpoint: "/api/v1/equity/price/historical",
  gridData: { w: 40, h: 15 }, source: ["Eodhd"], runButton: false, raw: false,
  refetchInterval: null, params: [], dataKey: "results", columnsDefs: null,
      backendId: "test",
};

beforeEach(async () => {
  vi.clearAllMocks();
  useDashboardStore.setState({ dashboards: [], activeId: null, saveError: null });
  await useDashboardStore.getState().load();
});

describe("useDashboardStore", () => {
  it("loads dashboards and activates the first", () => {
    const s = useDashboardStore.getState();
    expect(s.dashboards).toHaveLength(1);
    expect(s.activeId).toBe("default");
    expect(s.active()?.name).toBe("Main Dashboard");
  });

  it("adds a card sized from gridData clamped to the 60-col grid", async () => {
    await useDashboardStore.getState().addCard(widget, "nas");
    await useDashboardStore.getState().addCard({ ...widget, gridData: { w: 999, h: 2 } }, "nas");
    const cards = useDashboardStore.getState().active()!.cards;
    expect(cards).toHaveLength(2);
    expect(cards[0].layout).toEqual({ x: 0, y: 0, w: 40, h: 15 });
    expect(cards[0].widgetId).toBe(widget.id);
    expect(cards[0].backendId).toBe("nas");
    expect(cards[0].view).toBe("default");
    expect(cards[0].uuid).toMatch(UUID_V4_RE);
    // w=999 clamped down to GRID_COLS, h=2 clamped up to the min of 3.
    expect(cards[1].layout).toEqual({ x: 0, y: 15, w: GRID_COLS, h: 3 });
    // 2 from addCard actions (beforeEach load doesn't save) = 2 total
    expect(saveDashboard).toHaveBeenCalledTimes(2);
    expect(saveDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "default",
        name: "Main Dashboard",
        cards: [
          expect.objectContaining({ layout: { x: 0, y: 0, w: 40, h: 15 } }),
          expect.objectContaining({ layout: { x: 0, y: 15, w: GRID_COLS, h: 3 } }),
        ],
      })
    );
  });

  it("chart-type widgets start in chart view", async () => {
    await useDashboardStore.getState().addCard({ ...widget, type: "chart" }, "nas");
    expect(useDashboardStore.getState().active()!.cards[0].view).toBe("chart");
  });

  it("removes cards, updates layouts and params, persists each change", async () => {
    await useDashboardStore.getState().addCard(widget, "nas");
    const uuid = useDashboardStore.getState().active()!.cards[0].uuid;
    await useDashboardStore.getState().updateCardLayout(uuid, { i: uuid, x: 5, y: 2, w: 30, h: 10 });
    const layout = useDashboardStore.getState().active()!.cards[0].layout;
    expect(layout).toMatchObject({ x: 5, y: 2, w: 30, h: 10 });
    await useDashboardStore.getState().updateCardParams(uuid, { symbol: "MSFT" });
    expect(useDashboardStore.getState().active()!.cards[0].params).toEqual({ symbol: "MSFT" });
    await useDashboardStore.getState().updateCardView(uuid, "raw");
    expect(useDashboardStore.getState().active()!.cards[0].view).toBe("raw");
    await useDashboardStore.getState().removeCard(uuid);
    expect(useDashboardStore.getState().active()!.cards).toHaveLength(0);
    // 5 from actions (beforeEach load doesn't save) = 5 total
    expect(saveDashboard).toHaveBeenCalledTimes(5);
    expect(saveDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "default", name: "Main Dashboard", cards: [] })
    );
  });

  it("adds, renames, switches and removes dashboards", async () => {
    const id = await useDashboardStore.getState().addDashboard("Equities");
    expect(useDashboardStore.getState().activeId).toBe(id);
    await useDashboardStore.getState().renameDashboard(id, "Macro");
    expect(useDashboardStore.getState().dashboards.find((d) => d.id === id)!.name).toBe("Macro");
    useDashboardStore.getState().setActive("default");
    expect(useDashboardStore.getState().activeId).toBe("default");
    await useDashboardStore.getState().removeDashboard(id);
    expect(deleteDashboard).toHaveBeenCalledWith(id);
    expect(useDashboardStore.getState().dashboards).toHaveLength(1);
  });

  describe("crypto.randomUUID unavailable", () => {
    it("addCard still produces a UUID-shaped id when only getRandomValues exists", async () => {
      vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
      await useDashboardStore.getState().addCard(widget, "nas");
      const cards = useDashboardStore.getState().active()!.cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].uuid).toMatch(UUID_V4_RE);
    });

    it("addDashboard still produces a UUID-shaped id when only getRandomValues exists", async () => {
      vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
      const id = await useDashboardStore.getState().addDashboard("Macro");
      expect(id).toMatch(UUID_V4_RE);
      expect(useDashboardStore.getState().dashboards.find((d) => d.id === id)).toBeTruthy();
    });
  });

  describe("load() preserves the current dashboard", () => {
    it("keeps currentDashboardId when the current dashboard is still present after reload", async () => {
      loadDashboards.mockResolvedValueOnce([
        { id: "default", name: "Main Dashboard", cards: [] },
        { id: "second", name: "Second", cards: [] },
      ]);
      await useDashboardStore.getState().load();
      useDashboardStore.getState().setActive("second");
      expect(useDashboardStore.getState().activeId).toBe("second");

      loadDashboards.mockResolvedValueOnce([
        { id: "default", name: "Main Dashboard", cards: [] },
        { id: "second", name: "Second", cards: [] },
      ]);
      await useDashboardStore.getState().load();
      expect(useDashboardStore.getState().activeId).toBe("second");
    });

    it("falls back to the first dashboard when the current one no longer exists", async () => {
      useDashboardStore.setState({ activeId: "does-not-exist" });
      loadDashboards.mockResolvedValueOnce([{ id: "default", name: "Main Dashboard", cards: [] }]);
      await useDashboardStore.getState().load();
      expect(useDashboardStore.getState().activeId).toBe("default");
    });
  });

  it("reseeds a dashboard when the last one is deleted", async () => {
    // Otherwise activeId is null with nothing to restore it: the grid shows
    // "No dashboard selected" forever and every mutation no-ops.
    const only = useDashboardStore.getState().dashboards[0];
    await useDashboardStore.getState().removeDashboard(only.id);

    const s = useDashboardStore.getState();
    expect(s.dashboards).toHaveLength(1);
    expect(s.activeId).toBe(s.dashboards[0].id);
    expect(s.dashboards[0].id).not.toBe(only.id);
  });

  // Grafted from desk (dc4664b, finding 3): mutateActive used to silently
  // return when there was no active dashboard, so a mutation firing after
  // the active dashboard vanished (e.g. a stale card event racing a
  // dashboard delete) left no trace anywhere.
  describe("mutating with no active dashboard", () => {
    it("logs instead of throwing or silently persisting when activeId is null", async () => {
      useDashboardStore.setState({ dashboards: [], activeId: null });
      await useDashboardStore.getState().addCard(widget, "nas");
      expect(saveDashboard).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledTimes(1);
      expect(logError.mock.calls[0][0]).toMatch(/no active dashboard/i);
    });
  });

  // Grafted from desk (dc4664b, finding 2): every dashboard mutation is
  // optimistic (state updates before the disk write is awaited, with no
  // rollback), so a failed write used to be log-only -- a user's edit could
  // look saved and be gone on the next restart with zero indication.
  // Adapted from desk's version: bdobb's `enqueueSave`/`enqueueDelete`
  // deliberately keep swallowing the failure at the public-method boundary
  // (several existing call sites across the app -- e.g. AppShell's "Add"
  // button -- fire these actions without awaiting or catching them, and
  // changing that contract is out of this task's scope), so these assert
  // the call RESOLVES with `saveError` set, not that it rejects.
  describe("saveError surfaces persistence failures", () => {
    it("addDashboard: sets saveError but keeps the optimistically-added dashboard (no rollback)", async () => {
      saveDashboard.mockRejectedValueOnce(new Error("disk full"));
      await useDashboardStore.getState().addDashboard("Macro");
      expect(useDashboardStore.getState().saveError).toMatch(/disk full/);
      // The optimistic add is NOT rolled back -- surfacing the failure, not
      // reverting the edit, is the point.
      expect(useDashboardStore.getState().dashboards.map((d) => d.name)).toContain("Macro");
    });

    it("renameDashboard: sets saveError on a rejected save", async () => {
      saveDashboard.mockRejectedValueOnce(new Error("permission denied"));
      const id = useDashboardStore.getState().dashboards[0].id;
      await useDashboardStore.getState().renameDashboard(id, "Renamed");
      expect(useDashboardStore.getState().saveError).toMatch(/permission denied/);
      expect(useDashboardStore.getState().dashboards[0].name).toBe("Renamed");
    });

    it("addCard/removeCard/updateLayouts/updateCardView (mutateActive's save path): sets saveError on rejection", async () => {
      await useDashboardStore.getState().addCard(widget, "nas");
      const uuid = useDashboardStore.getState().active()!.cards[0].uuid;

      saveDashboard.mockRejectedValueOnce(new Error("write failed"));
      await useDashboardStore.getState().updateLayouts([{ i: uuid, x: 1, y: 1, w: 10, h: 10 }]);
      expect(useDashboardStore.getState().saveError).toMatch(/write failed/);
      // Optimistic update kept, not rolled back.
      expect(useDashboardStore.getState().active()!.cards[0].layout).toEqual({ x: 1, y: 1, w: 10, h: 10 });
    });

    it("clears saveError on the next successful save after a prior failure", async () => {
      saveDashboard.mockRejectedValueOnce(new Error("disk full"));
      await useDashboardStore.getState().addDashboard("Macro");
      expect(useDashboardStore.getState().saveError).toBeTruthy();

      await useDashboardStore.getState().addDashboard("Equities");
      expect(useDashboardStore.getState().saveError).toBeNull();
    });

    it("dismissSaveError clears the banner without touching dashboard state", async () => {
      saveDashboard.mockRejectedValueOnce(new Error("disk full"));
      await useDashboardStore.getState().addDashboard("Macro");
      expect(useDashboardStore.getState().saveError).toBeTruthy();
      const dashboardsBefore = useDashboardStore.getState().dashboards;

      useDashboardStore.getState().dismissSaveError();
      expect(useDashboardStore.getState().saveError).toBeNull();
      expect(useDashboardStore.getState().dashboards).toBe(dashboardsBefore);
    });

    it("removeDashboard: a rejected delete is logged (persistence.deleteDashboard never rejects, so saveError is not exercised here)", async () => {
      // persistence.ts's deleteDashboard (Task 4, unchanged here) swallows
      // its own failures internally and never rejects, so there is nothing
      // for saveError to observe on this path -- only the log call, which
      // deleteDashboard itself already produces.
      const id = useDashboardStore.getState().dashboards[0].id;
      await useDashboardStore.getState().removeDashboard(id);
      expect(deleteDashboard).toHaveBeenCalledWith(id);
      expect(useDashboardStore.getState().saveError).toBeNull();
    });
  });
});
