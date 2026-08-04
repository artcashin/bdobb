import { create } from "zustand";
import type { CardView, Dashboard, DashboardCard, ParamValues, WidgetDef } from "../lib/types";
import { loadDashboards, saveDashboard, deleteDashboard } from "../lib/persistence";
import { logError } from "../lib/logger";
import { newId } from "../lib/uuid";
import { initialParamValues } from "../lib/params";

export const GRID_COLS = 60;
export const GRID_ROW_HEIGHT = 24; // px per grid row

interface LayoutItem { i: string; x: number; y: number; w: number; h: number; }

// Dashboard writes are serialized through a single chain. saveDashboard is an
// async IPC round-trip with no ordering guarantee, and a drag fires one
// mutation per grid item, so unserialized writes can complete out of order and
// leave pre-drag positions on disk while memory holds the new ones.
let writeChain: Promise<void> = Promise.resolve();

// Every write funnels through here so `saveError` (desk finding 2: every
// mutation is optimistic -- state updates before the disk write is awaited,
// with no rollback) always reflects the most recent outcome: cleared on
// success, set to a human-readable message on failure. Deliberately does NOT
// rethrow to its own caller -- several call sites across the app fire these
// store actions without awaiting or catching them (e.g. AppShell's "Add"
// button), and changing that contract is out of this task's scope, so the
// existing swallow-and-log behavior is kept; this wrapper only ALSO makes
// the failure visible to the UI via `saveError`.
function trackWrite(
  set: (p: Partial<DashboardState>) => void,
  op: () => Promise<void>,
  logContext: string
): Promise<void> {
  return op().then(
    () => set({ saveError: null }),
    (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      logError(`dashboardStore: ${logContext}: ${reason}`);
      set({ saveError: `Failed to save: ${reason}` });
    }
  );
}

function enqueueSave(set: (p: Partial<DashboardState>) => void, dashboard: Dashboard): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(() => trackWrite(set, () => saveDashboard(dashboard), `failed to save ${dashboard.id}`));
  return writeChain;
}

function enqueueDelete(
  set: (p: Partial<DashboardState>) => void,
  id: string,
  logContext = `failed to delete ${id}`
): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(() => trackWrite(set, () => deleteDashboard(id), logContext));
  return writeChain;
}

interface DashboardState {
  dashboards: Dashboard[];
  /** id of the dashboard the grid renders; null when none is loaded */
  activeId: string | null;
  /**
   * Set whenever a persistence write rejects. Every dashboard mutation
   * applies to in-memory state optimistically, then awaits the disk write --
   * with no rollback. Before this field existed, a failed write was
   * log-only, so a user's edit could look saved in the UI and be gone on the
   * next restart with no on-screen indication. Cleared on the next
   * successful write. The optimistic update itself is intentionally NOT
   * rolled back on failure -- this field exists to make the failure
   * visible, not to revert the edit. Read by a DashboardTabs banner (Task
   * 16 of the reconciliation plan; not wired up yet).
   */
  saveError: string | null;
  /** Dismisses the banner without touching dashboard state -- the NEXT
   * write's outcome (success or failure) sets `saveError` again regardless. */
  dismissSaveError(): void;
  addDashboard(name: string): Promise<string>;
  removeDashboard(id: string): Promise<void>;
  renameDashboard(id: string, name: string): Promise<void>;
  setDashboards(dashboards: Dashboard[]): Promise<void>;
  restore(dashboards: Dashboard[], activeId: string | null): Promise<void>;
  addDashboards(incoming: Dashboard[]): Promise<void>;
  addCard(widget: WidgetDef, backendId: string, layout?: LayoutItem, params?: ParamValues): Promise<void>;
  removeCard(uuid: string): Promise<void>;
  updateCardLayout(uuid: string, layout: LayoutItem): Promise<void>;
  updateCardParams(uuid: string, params: ParamValues): Promise<void>;
  setGroupValue(groupId: string, value: ParamValues[string]): Promise<void>;
  updateCardView(uuid: string, view: CardView): Promise<void>;
  updateLayouts(layout: LayoutItem[]): Promise<void>;
  load(): Promise<void>;
  active(): Dashboard | null;
  setActive(id: string): void;
}

export const useDashboardStore = create<DashboardState>()((set, get) => {
  /**
   * Apply fn to the active dashboard and persist only that dashboard.
   * Every card mutation shares this: rewriting all dashboards on each change
   * multiplied disk traffic by the dashboard count for no benefit.
   */
  async function mutateActive(fn: (d: Dashboard) => Dashboard): Promise<void> {
    const { dashboards, activeId } = get();
    const idx = dashboards.findIndex((d) => d.id === activeId);
    if (idx < 0) {
      // Previously a silent no-op: a card mutation firing with no active
      // dashboard (e.g. a stale event after the active dashboard was
      // deleted) vanished with no trace anywhere. Logged instead so the gap
      // is at least visible if it ever fires.
      logError(`dashboardStore: mutation attempted with no active dashboard (activeId=${String(activeId)})`);
      return;
    }
    const next = fn(dashboards[idx]);
    const nextList = [...dashboards];
    nextList[idx] = next;
    set({ dashboards: nextList });
    await enqueueSave(set, next);
  }

  return {
    dashboards: [],
    activeId: null,
    saveError: null,
    dismissSaveError() {
      set({ saveError: null });
    },

    async addDashboard(name) {
      const d: Dashboard = { id: newId(), name, cards: [] };
      // Switch to the new dashboard, or card mutations would target it while
      // the grid still rendered the previous one.
      set({ dashboards: [...get().dashboards, d], activeId: d.id });
      await enqueueSave(set, d);
      return d.id;
    },

    async removeDashboard(id) {
      const rest = get().dashboards.filter((d) => d.id !== id);
      const activeId = get().activeId === id ? rest[0]?.id ?? null : get().activeId;
      set({ dashboards: rest, activeId });

      // Through the write chain, not around it: a queued saveDashboard for
      // this id would otherwise complete after the delete and recreate the
      // file, resurrecting the dashboard on next launch.
      await enqueueDelete(set, id);

      // Deleting the last dashboard left activeId null with nothing to
      // reseed it, so the grid showed "No dashboard selected" permanently and
      // every mutation silently no-oped.
      if (rest.length === 0) {
        const main: Dashboard = { id: newId(), name: "Main", cards: [] };
        set({ dashboards: [main], activeId: main.id });
        await enqueueSave(set, main);
      }
    },

    async renameDashboard(id, name) {
      const target = get().dashboards.find((d) => d.id === id);
      if (!target) return;
      const renamed = { ...target, name };
      set({ dashboards: get().dashboards.map((d) => (d.id === id ? renamed : d)) });
      await enqueueSave(set, renamed);
    },

    /**
     * Appends imported dashboards and switches to the first of them.
     * Distinct from setDashboards, which replaces: an import must not discard
     * what the user already has.
     */
    async addDashboards(incoming) {
      if (incoming.length === 0) return;
      set({ dashboards: [...get().dashboards, ...incoming], activeId: incoming[0].id });
      for (const d of incoming) await enqueueSave(set, d);
    },

    /**
     * Puts a previous state back, for undo.
     *
     * Distinct from setDashboards: dashboards created since the snapshot must
     * be deleted from disk, not merely dropped from memory, or they reappear on
     * the next launch and the undo silently comes apart.
     */
    async restore(dashboards, activeId) {
      const removed = get()
        .dashboards.map((d) => d.id)
        .filter((id) => !dashboards.some((d) => d.id === id));

      set({ dashboards, activeId: activeId ?? dashboards[0]?.id ?? null });

      for (const d of dashboards) await enqueueSave(set, d);
      for (const id of removed) {
        await enqueueDelete(set, id, `restore: failed to delete ${id}`);
      }
    },

    async setDashboards(dashboards) {
      set({ dashboards });
      for (const dashboard of dashboards) await enqueueSave(set, dashboard);
    },

    async addCard(widget, backendId, layout, params?: ParamValues) {
      // Seed from the widget's own defaults, resolving $currentDate, so a card
      // added today starts on today's date rather than the literal string.
      const seeded: ParamValues = { ...initialParamValues(widget), ...(params ?? {}) };
      await mutateActive((d) => {
        const bottom = d.cards.reduce((m, c) => Math.max(m, c.layout.y + c.layout.h), 0);
        const card: DashboardCard = {
          uuid: newId(),
          widgetId: widget.id,
          backendId,
          layout: layout ?? {
            x: 0,
            y: bottom,
            w: Math.max(4, Math.min(widget.gridData.w, GRID_COLS)),
            h: Math.max(3, Math.min(widget.gridData.h, 60)),
          },
          params: seeded,
          view: widget.type === "chart" ? "chart" : "default",
        };
        return { ...d, cards: [...d.cards, card] };
      });
    },

    async removeCard(uuid) {
      await mutateActive((d) => ({ ...d, cards: d.cards.filter((c) => c.uuid !== uuid) }));
    },

    async updateCardLayout(uuid, layout) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => (c.uuid === uuid ? { ...c, layout } : c)),
      }));
    },

    async updateCardParams(uuid, params) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => (c.uuid === uuid ? { ...c, params } : c)),
      }));
    },

    /**
     * Updates a shared parameter value. Every card in the group derives its
     * parameters from here, so one write is what makes them all refetch —
     * there is no per-card fan-out to do.
     */
    async setGroupValue(groupId, value) {
      await mutateActive((d) => ({
        ...d,
        groups: (d.groups ?? []).map((g) => (g.id === groupId ? { ...g, value } : g)),
      }));
    },

    async updateCardView(uuid, view) {
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => (c.uuid === uuid ? { ...c, view } : c)),
      }));
    },

    async updateLayouts(layout) {
      const byId = new Map(layout.map((l) => [l.i, { x: l.x, y: l.y, w: l.w, h: l.h }]));
      // Build fresh card objects: mutating c.layout in place would rewrite
      // objects still referenced by the previous state, so any memoized
      // consumer comparing card identity would miss the change.
      await mutateActive((d) => ({
        ...d,
        cards: d.cards.map((c) => {
          const next = byId.get(c.uuid);
          return next ? { ...c, layout: next } : c;
        }),
      }));
    },

    async load() {
      const dashboards = await loadDashboards();
      const previous = get().activeId;
      const activeId = dashboards.length > 0
        ? (dashboards.find((d) => d.id === previous)?.id ?? dashboards[0].id)
        : null;
      set({ dashboards, activeId });
    },

    active() {
      const { dashboards, activeId } = get();
      return dashboards.find((d) => d.id === activeId) ?? null;
    },

    setActive(id: string) {
      set({ activeId: id });
    },
  };
});
