import { create } from "zustand";
import type { DashboardSnapshot } from "../lib/agent/localTools";
import { useDashboardStore } from "./dashboardStore";
import { logError } from "../lib/logger";

interface AgentEdit {
  id: number;
  /** Phrased for a banner: "created dashboard \"Macro Watch\"". */
  label: string;
  /** The state to put back. */
  before: DashboardSnapshot;
}

interface AgentEditsState {
  /** Most recent last. */
  edits: AgentEdit[];
  record(label: string, before: DashboardSnapshot): void;
  undoLast(): Promise<void>;
  clear(): void;
}

let nextId = 1;

/**
 * Undo for dashboard changes the agent made.
 *
 * Agent edits apply immediately rather than asking first — a confirmation on
 * every step would make building a dashboard by conversation slower than doing
 * it by hand. That is only reasonable if the change is reversible, which is
 * what this holds: the full dashboard state from before each change.
 *
 * A stack rather than a single slot, because one turn can produce several
 * calls — "make me a macro dashboard with these four widgets" is a create plus
 * four adds — and being able to undo only the last of them would be a trap.
 */
export const useAgentEditsStore = create<AgentEditsState>()((set, get) => ({
  edits: [],

  record(label, before) {
    // Bounded: these hold a full copy of every dashboard, and a long
    // conversation would otherwise accumulate them for the whole session.
    const edits = [...get().edits, { id: nextId++, label, before }].slice(-20);
    set({ edits });
  },

  async undoLast() {
    const edits = get().edits;
    const last = edits[edits.length - 1];
    if (!last) return;

    set({ edits: edits.slice(0, -1) });
    try {
      await useDashboardStore.getState().restore(last.before.dashboards, last.before.activeId);
    } catch (e) {
      logError(`undo failed: ${String(e)}`);
      throw e;
    }
  },

  clear() {
    set({ edits: [] });
  },
}));
