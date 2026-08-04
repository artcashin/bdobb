import { describe, expect, it, vi } from "vitest";
import { executeLocalTool, LOCAL_TOOLS, LOCAL_TOOL_SERVER_ID } from "./localTools";
import { makeWidgetDef } from "../../test/widgetDef";
import type { Dashboard } from "../types";

function harness(over: Partial<{ dashboards: Dashboard[]; activeId: string | null }> = {}) {
  const state = {
    dashboards: over.dashboards ?? [{ id: "d1", name: "Main", cards: [] }],
    activeId: over.activeId !== undefined ? over.activeId : "d1",
  };
  const widgets = [
    makeWidgetDef({ id: "historical_prices", name: "Historical Prices", backendId: "nas" }),
    makeWidgetDef({ id: "company_details", name: "Company Details", backendId: "nas" }),
  ];
  const added: string[] = [];
  const snapshots: { label: string; count: number }[] = [];

  const deps = {
    getDashboards: () => state.dashboards,
    getActiveId: () => state.activeId,
    getWidgets: () => widgets,
    createDashboard: vi.fn(async (name: string) => {
      const id = `new-${state.dashboards.length}`;
      state.dashboards = [...state.dashboards, { id, name, cards: [] }];
      return id;
    }),
    setActive: (id: string) => {
      state.activeId = id;
    },
    addWidget: vi.fn(async (w: { id: string }) => {
      added.push(w.id);
    }),
    onBeforeChange: (label: string, snap: { dashboards: Dashboard[] }) =>
      snapshots.push({ label, count: snap.dashboards.length }),
  };
  return { state, deps, added, snapshots, widgets };
}

describe("local tool descriptors", () => {
  it("declares every tool under the reserved server id", () => {
    // The server_id is what routes execute_agent_tool back here rather than to
    // a real MCP server.
    expect(LOCAL_TOOLS.every((t) => t.server_id === LOCAL_TOOL_SERVER_ID)).toBe(true);
    expect(LOCAL_TOOLS.map((t) => t.name).sort()).toEqual(["add_widget", "create_dashboard"]);
  });
});

describe("create_dashboard", () => {
  it("creates and populates a dashboard", async () => {
    const h = harness();
    const r = await executeLocalTool(
      "create_dashboard",
      { name: "Macro", widget_ids: ["historical_prices"] },
      h.deps
    );
    expect(h.deps.createDashboard).toHaveBeenCalledWith("Macro");
    expect(h.added).toEqual(["historical_prices"]);
    expect(r.content).toContain("Macro");
    expect(r.isError).toBeFalsy();
  });

  it("snapshots before touching anything", async () => {
    // Undo is what makes applying without asking acceptable, so the snapshot
    // has to precede the first mutation.
    const h = harness();
    await executeLocalTool("create_dashboard", { name: "Macro" }, h.deps);
    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0].count).toBe(1); // state before the new dashboard existed
    expect(h.state.dashboards).toHaveLength(2);
  });

  it("reports widgets it could not place rather than claiming success", async () => {
    const h = harness();
    const r = await executeLocalTool(
      "create_dashboard",
      { name: "Macro", widget_ids: ["historical_prices", "does_not_exist"] },
      h.deps
    );
    expect(h.added).toEqual(["historical_prices"]);
    expect(r.content).toContain("does_not_exist");
  });

  it("matches a widget by display name, not just id", async () => {
    // A model asked to add "the historical prices widget" reliably produces a
    // plausible identifier rather than an exact one.
    const h = harness();
    await executeLocalTool(
      "create_dashboard",
      { name: "Macro", widget_ids: ["Historical Prices"] },
      h.deps
    );
    expect(h.added).toEqual(["historical_prices"]);
  });

  it("refuses without a name", async () => {
    const h = harness();
    const r = await executeLocalTool("create_dashboard", { name: "  " }, h.deps);
    expect(r.isError).toBe(true);
    expect(h.deps.createDashboard).not.toHaveBeenCalled();
  });
});

describe("add_widget", () => {
  it("adds to the active dashboard by default", async () => {
    const h = harness();
    const r = await executeLocalTool("add_widget", { widget_id: "company_details" }, h.deps);
    expect(h.added).toEqual(["company_details"]);
    expect(r.content).toContain("Main");
  });

  it("targets a named dashboard", async () => {
    const h = harness({
      dashboards: [
        { id: "d1", name: "Main", cards: [] },
        { id: "d2", name: "Macro", cards: [] },
      ],
    });
    await executeLocalTool(
      "add_widget",
      { widget_id: "company_details", dashboard_name: "macro" },
      h.deps
    );
    expect(h.state.activeId).toBe("d2");
  });

  it("says which ids exist when the name does not match", async () => {
    // The agent can correct itself only if the failure names the alternatives.
    const h = harness();
    const r = await executeLocalTool("add_widget", { widget_id: "nope" }, h.deps);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("historical_prices");
    expect(h.added).toEqual([]);
  });

  it("errors on an unknown dashboard rather than adding somewhere else", async () => {
    const h = harness();
    const r = await executeLocalTool(
      "add_widget",
      { widget_id: "company_details", dashboard_name: "Nowhere" },
      h.deps
    );
    expect(r.isError).toBe(true);
    expect(h.added).toEqual([]);
  });
});

describe("unknown tools", () => {
  it("reports rather than throwing", async () => {
    const h = harness();
    const r = await executeLocalTool("drop_everything", {}, h.deps);
    expect(r.isError).toBe(true);
  });
});
