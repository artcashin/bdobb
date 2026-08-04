import { describe, expect, it } from "vitest";
import {
  appsJsonToDashboards,
  dashboardsToAppsJson,
  WORKSPACE_GRID_COLS,
  type AppsJsonApp,
  type WidgetResolver,
} from "./appsJson";
import { GRID_COLS } from "../stores/dashboardStore";
import { makeWidgetDef } from "../test/widgetDef";
import type { Dashboard } from "./types";
import { BUILTIN_NOTE_ID, findBuiltin } from "./builtins";

const resolveAll: WidgetResolver = (widgetId) => ({
  backendId: "b1",
  widget: makeWidgetDef({ id: widgetId }),
});

const resolveNone: WidgetResolver = () => null;

function app(over: Partial<AppsJsonApp> = {}): AppsJsonApp {
  return {
    name: "Test App",
    tabs: {
      overview: {
        id: "overview",
        name: "Overview",
        layout: [{ i: "w1", x: 0, y: 0, w: 20, h: 10 }],
      },
    },
    ...over,
  };
}

describe("appsJsonToDashboards", () => {
  it("turns each tab into a dashboard", () => {
    const { dashboards } = appsJsonToDashboards([app()], resolveAll);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].name).toBe("Overview");
    expect(dashboards[0].cards).toHaveLength(1);
    expect(dashboards[0].cards[0].widgetId).toBe("w1");
    expect(dashboards[0].cards[0].backendId).toBe("b1");
  });

  it("scales columns from Workspace's 40-column grid to BDOBB's 60", () => {
    const { dashboards } = appsJsonToDashboards(
      [
        app({
          tabs: {
            t: {
              id: "t",
              name: "T",
              layout: [
                { i: "left", x: 0, y: 0, w: 40, h: 5 }, // full width
                { i: "half", x: 20, y: 5, w: 20, h: 5 }, // right half
              ],
            },
          },
        }),
      ],
      resolveAll
    );
    const [full, half] = dashboards[0].cards;
    expect(full.layout).toMatchObject({ x: 0, w: GRID_COLS });
    // 20/40 of the way across, 20/40 wide -> 30/60 and 30/60.
    expect(half.layout).toMatchObject({ x: 30, w: 30 });
  });

  it("keeps x at 0 rather than shifting the leftmost column", () => {
    // Scaling a position with a width's clamp (min 1) moves every card in the
    // first column one place right, which skews the whole layout.
    const { dashboards } = appsJsonToDashboards([app()], resolveAll);
    expect(dashboards[0].cards[0].layout.x).toBe(0);
  });

  it("never lets a card overhang the grid", () => {
    const { dashboards } = appsJsonToDashboards(
      [
        app({
          tabs: {
            t: { id: "t", name: "T", layout: [{ i: "edge", x: 39, y: 0, w: 40, h: 5 }] },
          },
        }),
      ],
      resolveAll
    );
    const { x, w } = dashboards[0].cards[0].layout;
    expect(x + w).toBeLessThanOrEqual(GRID_COLS);
  });

  it("reports widgets no backend provides instead of dropping them silently", () => {
    // A Workspace dashboard whose widgets come from a backend the user has not
    // added must say so, not render as a mysteriously empty grid.
    const { dashboards, unresolved } = appsJsonToDashboards([app()], resolveNone);
    expect(dashboards[0].cards).toHaveLength(0);
    expect(unresolved).toEqual([{ dashboard: "Overview", widgetId: "w1" }]);
  });

  it("turns app groups into dashboard groups and binds the cards", () => {
    const { dashboards, warnings } = appsJsonToDashboards(
      [
        app({
          groups: [
            { name: "Group 1", type: "endpointParam", paramName: "symbol", defaultValue: "AAPL" },
          ],
          tabs: {
            t: {
              id: "t",
              name: "T",
              layout: [
                { i: "w1", x: 0, y: 0, w: 10, h: 5, groups: ["Group 1"] },
                { i: "w2", x: 10, y: 0, w: 10, h: 5, groups: ["Group 1"] },
                { i: "w3", x: 20, y: 0, w: 10, h: 5 },
              ],
            },
          },
        }),
      ],
      resolveAll
    );

    const d = dashboards[0];
    expect(d.groups).toHaveLength(1);
    expect(d.groups![0]).toMatchObject({ name: "Group 1", paramName: "symbol", value: "AAPL" });

    const gid = d.groups![0].id;
    expect(d.cards[0].groups).toEqual([gid]);
    expect(d.cards[1].groups).toEqual([gid]);
    expect(d.cards[2].groups).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("keeps only the groups a dashboard actually uses", () => {
    const { dashboards } = appsJsonToDashboards(
      [
        app({
          groups: [
            { name: "Used", paramName: "symbol", defaultValue: "AAPL" },
            { name: "Unused", paramName: "year", defaultValue: "2024" },
          ],
          tabs: {
            t: { id: "t", name: "T", layout: [{ i: "w1", x: 0, y: 0, w: 10, h: 5, groups: ["Used"] }] },
          },
        }),
      ],
      resolveAll
    );
    expect(dashboards[0].groups!.map((g) => g.name)).toEqual(["Used"]);
  });

  it("warns when a group spans tabs, and gives each dashboard its own copy", () => {
    // Workspace scopes groups to an app, BDOBB to a dashboard. The narrowing is
    // deliberate; leaving it silent would be the problem.
    const { dashboards, warnings } = appsJsonToDashboards(
      [
        app({
          groups: [{ name: "Shared", paramName: "symbol", defaultValue: "AAPL" }],
          tabs: {
            a: { id: "a", name: "A", layout: [{ i: "w1", x: 0, y: 0, w: 10, h: 5, groups: ["Shared"] }] },
            b: { id: "b", name: "B", layout: [{ i: "w2", x: 0, y: 0, w: 10, h: 5, groups: ["Shared"] }] },
          },
        }),
      ],
      resolveAll
    );
    expect(warnings.join(" ")).toMatch(/shared across several tabs/i);
    const ids = dashboards.map((d) => d.groups![0].id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("records the app a tab came from instead of flattening it into the name", () => {
    // Names used to be prefixed ("Test App — Overview") to disambiguate. The
    // dashboard now says which app it belongs to, so the tab keeps its own
    // name and the strip groups by app.
    const { dashboards } = appsJsonToDashboards([app(), app({ name: "Other" })], resolveAll);
    expect(dashboards.map((d) => d.name)).toEqual(["Overview", "Overview"]);
    expect(dashboards.map((d) => d.appName)).toEqual(["Test App", "Other"]);
  });

  it("recovers the readable tabs from a partly malformed file", () => {
    // Recovering most of a hand-edited file beats failing the whole import.
    const { dashboards } = appsJsonToDashboards(
      [
        {
          name: "Mixed",
          tabs: {
            good: { id: "good", name: "Good", layout: [{ i: "w1", x: 0, y: 0, w: 10, h: 5 }] },
            broken: { id: "broken", name: "Broken", layout: "not an array" },
            partial: {
              id: "partial",
              name: "Partial",
              layout: [{ i: "w2", x: 0, y: 0, w: 10, h: 5 }, { nope: true }, null],
            },
          },
        } as never,
      ],
      resolveAll
    );
    expect(dashboards.map((d) => d.name)).toEqual(["Good", "Partial"]);
    expect(dashboards[1].cards).toHaveLength(1);
  });

  it("returns a warning rather than throwing on junk input", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      const r = appsJsonToDashboards(junk, resolveAll);
      expect(r.dashboards).toEqual([]);
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe("dashboardsToAppsJson", () => {
  const dash: Dashboard = {
    id: "d1",
    name: "My Overview",
    cards: [
      {
        uuid: "c1",
        widgetId: "w1",
        backendId: "b1",
        layout: { x: 0, y: 0, w: 60, h: 10 },
        params: {},
        view: "default",
      },
      {
        uuid: "c2",
        widgetId: "w2",
        backendId: "b1",
        layout: { x: 30, y: 10, w: 30, h: 8 },
        params: {},
        view: "default",
      },
    ],
  };

  it("produces one app with a tab per dashboard", () => {
    const [out] = dashboardsToAppsJson([dash]);
    expect(Object.keys(out.tabs)).toEqual(["my-overview"]);
    expect(out.tabs["my-overview"].name).toBe("My Overview");
    expect(out.tabs["my-overview"].layout).toHaveLength(2);
  });

  it("scales back down to Workspace's grid", () => {
    const [out] = dashboardsToAppsJson([dash]);
    const [full, half] = out.tabs["my-overview"].layout;
    expect(full).toMatchObject({ i: "w1", x: 0, w: WORKSPACE_GRID_COLS });
    expect(half).toMatchObject({ i: "w2", x: 20, w: 20 });
    for (const l of out.tabs["my-overview"].layout) {
      expect(l.x + l.w).toBeLessThanOrEqual(WORKSPACE_GRID_COLS);
    }
  });

  it("gives colliding dashboard names distinct tab ids", () => {
    // Workspace keys tabs by id; two "Overview" dashboards must not collapse
    // into one tab and lose a dashboard.
    const [out] = dashboardsToAppsJson([
      { ...dash, id: "a", name: "Overview" },
      { ...dash, id: "b", name: "Overview" },
    ]);
    expect(Object.keys(out.tabs)).toEqual(["overview", "overview-2"]);
    expect(Object.values(out.tabs).map((t) => t.name)).toEqual(["Overview", "Overview"]);
  });

  it("survives a name with no usable characters", () => {
    const [out] = dashboardsToAppsJson([{ ...dash, name: "•••" }]);
    expect(Object.keys(out.tabs)).toEqual(["tab"]);
  });
});

describe("dashboardsToAppsJson groups", () => {
  it("emits app-level groups and references them by name from each card", () => {
    const [out] = dashboardsToAppsJson([
      {
        id: "d1",
        name: "Linked",
        groups: [{ id: "g1", name: "Group 1", paramName: "symbol", value: "AAPL" }],
        cards: [
          { uuid: "c1", widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 30, h: 5 }, params: {}, view: "default", groups: ["g1"] },
          { uuid: "c2", widgetId: "w2", backendId: "b1", layout: { x: 30, y: 0, w: 30, h: 5 }, params: {}, view: "default" },
        ],
      },
    ]);
    expect(out.groups).toEqual([
      { name: "Group 1", type: "param", paramName: "symbol", defaultValue: "AAPL" },
    ]);
    const layout = out.tabs["linked"].layout;
    expect(layout[0].groups).toEqual(["Group 1"]);
    expect(layout[1].groups).toEqual([]);
  });

  it("disambiguates group names colliding across dashboards", () => {
    // Names are the only handle a layout entry has, and groups are app-level in
    // apps.json. Two dashboards each holding a "Group 1" would otherwise merge
    // into a single shared value on the way back in.
    const mk = (id: string, name: string) => ({
      id,
      name,
      groups: [{ id: `${id}-g`, name: "Group 1", paramName: "symbol", value: id }],
      cards: [
        { uuid: `${id}-c`, widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 30, h: 5 }, params: {}, view: "default" as const, groups: [`${id}-g`] },
      ],
    });
    const [out] = dashboardsToAppsJson([mk("a", "A"), mk("b", "B")]);
    expect(out.groups!.map((g) => g.name)).toEqual(["Group 1", "Group 1 (2)"]);
    expect(out.tabs["a"].layout[0].groups).toEqual(["Group 1"]);
    expect(out.tabs["b"].layout[0].groups).toEqual(["Group 1 (2)"]);
  });
});

describe("dashboardsToAppsJson app grouping", () => {
  const dash = (name: string, appName?: string) => ({
    id: name, name, appName,
    cards: [{ uuid: `${name}-c`, widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 30, h: 5 }, params: {}, view: "default" as const }],
  });

  it("emits one app per appName", () => {
    // Collapsing everything into one app would merge separately imported apps
    // on the way back to Workspace.
    const out = dashboardsToAppsJson([
      dash("Types", "Onboarding"),
      dash("Plotly", "Onboarding"),
      dash("Macro", "Research"),
    ]);
    expect(out.map((a) => a.name)).toEqual(["Onboarding", "Research"]);
    expect(Object.keys(out[0].tabs)).toEqual(["types", "plotly"]);
    expect(Object.keys(out[1].tabs)).toEqual(["macro"]);
  });

  it("puts ungrouped dashboards in a single default app", () => {
    const out = dashboardsToAppsJson([dash("A"), dash("B")], { name: "Mine" });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Mine");
    expect(Object.keys(out[0].tabs)).toEqual(["a", "b"]);
  });

  it("scopes group-name collisions per app, not globally", () => {
    // Two apps may each legitimately hold a "Group 1"; only a collision within
    // one app would merge them on import.
    const withGroup = (name: string, appName: string, gid: string) => ({
      id: name, name, appName,
      groups: [{ id: gid, name: "Group 1", paramName: "symbol", value: name }],
      cards: [{ uuid: `${name}-c`, widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 30, h: 5 }, params: {}, view: "default" as const, groups: [gid] }],
    });
    const out = dashboardsToAppsJson([withGroup("A", "App1", "g1"), withGroup("B", "App2", "g2")]);
    expect(out[0].groups!.map((g) => g.name)).toEqual(["Group 1"]);
    expect(out[1].groups!.map((g) => g.name)).toEqual(["Group 1"]);
  });
});

describe("round trip", () => {
  it("preserves layout geometry through export and re-import", () => {
    const original: Dashboard = {
      id: "d1",
      name: "Round Trip",
      cards: [
        { uuid: "c1", widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 60, h: 10 }, params: {}, view: "default" },
        { uuid: "c2", widgetId: "w2", backendId: "b1", layout: { x: 30, y: 10, w: 30, h: 8 }, params: {}, view: "default" },
        { uuid: "c3", widgetId: "w3", backendId: "b1", layout: { x: 15, y: 18, w: 15, h: 6 }, params: {}, view: "default" },
      ],
    };

    const { dashboards } = appsJsonToDashboards(dashboardsToAppsJson([original]), resolveAll);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0].name).toBe("Round Trip");
    expect(dashboards[0].cards.map((c) => c.widgetId)).toEqual(["w1", "w2", "w3"]);
    // Both grids divide evenly by 15, so these coordinates convert exactly.
    // Coordinates that do not land on a shared boundary are rounded, which is
    // inherent to 40 <-> 60 and not something a round trip can undo.
    expect(dashboards[0].cards.map((c) => c.layout)).toEqual(
      original.cards.map((c) => c.layout)
    );
  });

  it("preserves grouping through export and re-import", () => {
    const original = {
      id: "d1",
      name: "Linked",
      groups: [{ id: "g1", name: "Group 1", paramName: "symbol", value: "AAPL" }],
      cards: [
        { uuid: "c1", widgetId: "w1", backendId: "b1", layout: { x: 0, y: 0, w: 30, h: 5 }, params: {}, view: "default" as const, groups: ["g1"] },
        { uuid: "c2", widgetId: "w2", backendId: "b1", layout: { x: 30, y: 0, w: 30, h: 5 }, params: {}, view: "default" as const, groups: ["g1"] },
      ],
    };

    const { dashboards } = appsJsonToDashboards(dashboardsToAppsJson([original]), resolveAll);
    const d = dashboards[0];
    expect(d.groups).toHaveLength(1);
    expect(d.groups![0]).toMatchObject({ name: "Group 1", paramName: "symbol", value: "AAPL" });
    // Ids are regenerated on import, but both cards must still land in the
    // same group as each other.
    expect(d.cards[0].groups).toEqual([d.groups![0].id]);
    expect(d.cards[1].groups).toEqual([d.groups![0].id]);
  });

  it("round trips a built-in widget", () => {
    // Built-ins belong to no backend and are never in the registry, so an
    // export/import cycle would report a note as "no backend provides this"
    // unless the resolver knows about them.
    const resolve = (id: string) => {
      const builtin = findBuiltin(id);
      return builtin ? { backendId: builtin.backendId, widget: builtin } : null;
    };
    const original = {
      id: "d1",
      name: "Notes",
      cards: [
        {
          uuid: "c1",
          widgetId: BUILTIN_NOTE_ID,
          backendId: "builtin",
          layout: { x: 0, y: 0, w: 30, h: 8 },
          params: { text: "hello" },
          view: "default" as const,
        },
      ],
    };

    const { dashboards, unresolved } = appsJsonToDashboards(
      dashboardsToAppsJson([original]),
      resolve
    );
    expect(unresolved).toEqual([]);
    expect(dashboards[0].cards[0].widgetId).toBe(BUILTIN_NOTE_ID);
    expect(dashboards[0].cards[0].backendId).toBe("builtin");
  });

  it("preserves app grouping through export and re-import", () => {
    const original = [
      { id: "d1", name: "Types", appName: "Onboarding", cards: [] },
      { id: "d2", name: "Plotly", appName: "Onboarding", cards: [] },
      { id: "d3", name: "Macro", appName: "Research", cards: [] },
    ];
    const { dashboards } = appsJsonToDashboards(dashboardsToAppsJson(original), resolveAll);
    expect(dashboards.map((d) => [d.appName, d.name])).toEqual([
      ["Onboarding", "Types"],
      ["Onboarding", "Plotly"],
      ["Research", "Macro"],
    ]);
  });
});