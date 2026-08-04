import { describe, expect, it, beforeAll, vi } from "vitest";

// fetchWidgetData goes through plugin-http, which has no implementation outside
// the Tauri runtime. Delegating to the platform fetch exercises the real
// URL-building, header and dataKey logic while leaving the transport to node.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

import { parseWidgetsJson } from "../../lib/widgets";
import { buildWidgetUrl, fetchWidgetData } from "../../lib/dataClient";
import { initialParamValues } from "../../lib/params";
import { appsJsonToDashboards, dashboardsToAppsJson } from "../../lib/appsJson";
import { effectiveParams } from "../../lib/paramGroups";
import { GRID_COLS } from "../../stores/dashboardStore";
import type { BackendConfig, WidgetDef } from "../../lib/types";

/**
 * Conformance suite against OpenBB's own reference backend.
 *
 * Distinct from the live-endpoint suite (arrives in v6.0.0), which needs a private deployment and is
 * therefore unrunnable by anyone but its owner. This one needs only a local
 * process anybody can start:
 *
 *   scripts/reference-backend.sh        # in one terminal
 *   pnpm test:reference                 # in another
 *
 * The value is that the fixture is not ours. Testing a widgets.json client
 * against a widgets.json we also wrote proves the two agree, not that either
 * matches the spec. This corpus is the spec's reference implementation, so a
 * disagreement here is BDOBB's bug.
 *
 * Opt-in rather than skip-if-unreachable: a suite that quietly turns itself off
 * when the backend is down reports green for a broken client, which is the
 * failure mode the whole exercise is meant to remove.
 */
const ENABLED = process.env.OPENBB_REFERENCE === "1";
const BASE_URL = process.env.OPENBB_REFERENCE_URL ?? "http://127.0.0.1:7779";

const backend: BackendConfig = {
  id: "reference",
  name: "OpenBB Reference Backend",
  baseUrl: BASE_URL,
};

/**
 * Widget types the reference backend publishes that BDOBB has no renderer for.
 * They fall through to the raw JSON view rather than crashing, which is the
 * designed behaviour — this list exists so that when OpenBB adds a type, or
 * BDOBB gains a renderer, the change is visible in a diff instead of silently
 * enlarging the set of widgets that render as JSON.
 */
const KNOWN_UNRENDERED = [
  "advanced_charting",
  "chart-highcharts",
  "chart-vegalite",
  "live_grid",
  "newsfeed",
  "omni",
  "youtube",
];

describe.skipIf(!ENABLED)("OpenBB reference backend conformance", () => {
  let raw: Record<string, unknown>;
  let widgets: WidgetDef[];

  beforeAll(async () => {
    const res = await fetch(`${BASE_URL}/widgets.json`).catch((e) => {
      throw new Error(
        `Could not reach the reference backend at ${BASE_URL}. ` +
          `Start it with scripts/reference-backend.sh. (${String(e)})`
      );
    });
    expect(res.ok, `${BASE_URL}/widgets.json returned HTTP ${res.status}`).toBe(true);
    raw = (await res.json()) as Record<string, unknown>;
    widgets = parseWidgetsJson(raw as never, backend.id);
  });

  it("serves a corpus large enough to be worth testing against", () => {
    // Guards against pointing this at something that merely answers 200 — an
    // empty or near-empty widgets.json would make every assertion below vacuous.
    expect(Object.keys(raw).length).toBeGreaterThan(50);
  });

  it("parses every widget the reference backend publishes", () => {
    // parseWidgetsJson drops entries it cannot make sense of. Against the
    // reference corpus it must drop none: anything discarded here is a field
    // the spec uses and the parser does not understand.
    const keptIds = new Set(widgets.map((w) => w.id));
    const dropped = Object.keys(raw).filter((id) => !keptIds.has(id));
    expect(dropped, `parser dropped: ${dropped.join(", ")}`).toEqual([]);
  });

  it("gives every parsed widget the fields the renderers require", () => {
    for (const w of widgets) {
      expect(w.id, "widget id").toBeTruthy();
      expect(typeof w.name, `${w.id}: name`).toBe("string");
      expect(typeof w.endpoint, `${w.id}: endpoint`).toBe("string");
      expect(w.gridData, `${w.id}: gridData`).toBeDefined();
      expect(Array.isArray(w.params), `${w.id}: params`).toBe(true);
    }
  });

  it("builds a same-origin URL for every widget", () => {
    // buildWidgetUrl resolves the endpoint beneath the backend's base path and
    // must not be steerable off-origin by anything in widgets.json.
    const origin = new URL(BASE_URL).origin;
    for (const w of widgets) {
      if (w.type === "iframe") continue; // iframe endpoints are absolute by design
      const url = buildWidgetUrl(backend, w, initialParamValues(w), { theme: "dark" });
      expect(new URL(url).origin, `${w.id} -> ${url}`).toBe(origin);
    }
  });

  it("fetches data for every table, metric and chart widget", async () => {
    const targets = widgets.filter((w) => ["table", "metric", "chart"].includes(w.type));
    expect(targets.length).toBeGreaterThan(10);

    const failures: string[] = [];
    for (const w of targets) {
      const values = initialParamValues(w);
      try {
        const data = await fetchWidgetData(backend, w, values, { theme: "dark" });
        // A 200 carrying null is still a widget that renders as "No data".
        if (data === null || data === undefined) {
          failures.push(`${w.id}: resolved to ${String(data)}`);
        }
      } catch (e) {
        failures.push(
          `${w.id} (${w.type}): ${String(e).slice(0, 120)} ` +
            `[${buildWidgetUrl(backend, w, values, { theme: "dark" })}]`
        );
      }
    }
    expect(failures, `\n${failures.join("\n")}`).toEqual([]);
  }, 120_000);

  it("has a renderer for every widget type except the known-unrendered set", () => {
    const RENDERED = [
      "table", "chart", "metric", "markdown", "html", "iframe", "pdf", "multi_file_viewer",
    ];
    const seen = [...new Set(widgets.map((w) => w.type))].sort();
    const unaccounted = seen.filter(
      (t) => !RENDERED.includes(t) && !KNOWN_UNRENDERED.includes(t)
    );
    // A new type upstream shows up here rather than quietly rendering as JSON.
    expect(
      unaccounted,
      `unrecognised widget types: ${unaccounted.join(", ")}. ` +
        `Add a renderer, or add them to KNOWN_UNRENDERED to acknowledge the gap.`
    ).toEqual([]);
  });

  it("imports the reference app's dashboards from apps.json", async () => {
    // The end-to-end check for the Workspace interchange path, against a real
    // apps.json rather than a fixture we wrote: 14 tabs laying out all 70
    // widgets. Every widget id in it must resolve against the widgets.json the
    // same backend serves, so nothing should come back unresolved.
    const res = await fetch(`${BASE_URL}/apps.json`);
    expect(res.ok, `${BASE_URL}/apps.json returned HTTP ${res.status}`).toBe(true);

    const byId = new Map(widgets.map((w) => [w.id, w]));
    const { dashboards, unresolved } = appsJsonToDashboards(await res.json(), (id) => {
      const widget = byId.get(id);
      return widget ? { backendId: backend.id, widget } : null;
    });

    expect(dashboards.length).toBeGreaterThan(5);
    expect(
      unresolved.map((u) => u.widgetId),
      "apps.json names widgets this backend's widgets.json does not define"
    ).toEqual([]);

    const cards = dashboards.flatMap((d) => d.cards);
    expect(cards.length).toBeGreaterThan(50);
    for (const c of cards) {
      expect(c.layout.x, `${c.widgetId} x`).toBeGreaterThanOrEqual(0);
      expect(c.layout.x + c.layout.w, `${c.widgetId} overhangs the grid`).toBeLessThanOrEqual(
        GRID_COLS
      );
      expect(c.layout.h, `${c.widgetId} h`).toBeGreaterThan(0);
    }
  });

  it("exports those dashboards back to an apps.json Workspace could read", () => {
    // A re-import must recover the same tabs and widgets: this is the path a
    // user takes moving a dashboard between BDOBB and pro.openbb.co.
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const resolve = (id: string) => {
      const widget = byId.get(id);
      return widget ? { backendId: backend.id, widget } : null;
    };

    const seeded = appsJsonToDashboards(
      [
        {
          name: "Seed",
          tabs: {
            a: { id: "a", name: "A", layout: widgets.slice(0, 4).map((w, i) => ({
              i: w.id, x: (i % 2) * 20, y: Math.floor(i / 2) * 10, w: 20, h: 10,
            })) },
          },
        },
      ],
      resolve
    ).dashboards;

    const round = appsJsonToDashboards(dashboardsToAppsJson(seeded), resolve).dashboards;
    expect(round.map((d) => d.name)).toEqual(seeded.map((d) => d.name));
    expect(round.flatMap((d) => d.cards.map((c) => c.widgetId))).toEqual(
      seeded.flatMap((d) => d.cards.map((c) => c.widgetId))
    );
    expect(round.flatMap((d) => d.cards.map((c) => c.layout))).toEqual(
      seeded.flatMap((d) => d.cards.map((c) => c.layout))
    );
  });

  it("binds the reference app's parameter groups to their cards", async () => {
    // The Grouping tab is the corpus's own demonstration of linked widgets:
    // two cards sharing company/year, and two sharing symbol. Without groups
    // the tab imports looking correct but behaving wrong, which is exactly the
    // failure that is invisible in a screenshot.
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const resolve = (id: string) => {
      const widget = byId.get(id);
      return widget ? { backendId: backend.id, widget } : null;
    };
    const raw = await fetch(`${BASE_URL}/apps.json`).then((r) => r.json());
    const { dashboards } = appsJsonToDashboards(raw, resolve);

    const grouping = dashboards.find((d) => d.name === "Grouping");
    expect(grouping, "the reference app should have a Grouping tab").toBeDefined();
    expect(grouping!.groups!.map((g) => g.paramName).sort()).toEqual([
      "company",
      "symbol",
      "year",
    ]);

    // Cards sharing a group must resolve to the same value for it.
    const byGroup = new Map<string, string[]>();
    for (const c of grouping!.cards) {
      for (const gid of c.groups ?? []) {
        byGroup.set(gid, [...(byGroup.get(gid) ?? []), c.widgetId]);
      }
    }
    expect([...byGroup.values()].every((members) => members.length >= 2)).toBe(true);

    for (const c of grouping!.cards) {
      const widget = byId.get(c.widgetId)!;
      const values = effectiveParams(widget, c, grouping!.groups);
      for (const g of grouping!.groups!) {
        if (!(c.groups ?? []).includes(g.id)) continue;
        const declares = (widget.params ?? []).some((p) => p.paramName === g.paramName);
        if (declares) expect(values[g.paramName], `${c.widgetId}.${g.paramName}`).toBe(g.value);
      }
    }
  });

  it("round trips the reference app's groups through an export", () => {
    const byId = new Map(widgets.map((w) => [w.id, w]));
    const resolve = (id: string) => {
      const widget = byId.get(id);
      return widget ? { backendId: backend.id, widget } : null;
    };
    const seeded = appsJsonToDashboards(
      [
        {
          name: "Seed",
          groups: [{ name: "G", type: "param", paramName: "symbol", defaultValue: "AAPL" }],
          tabs: {
            t: {
              id: "t",
              name: "T",
              layout: widgets.slice(0, 3).map((w, i) => ({
                i: w.id, x: i * 13, y: 0, w: 13, h: 8, groups: ["G"],
              })),
            },
          },
        },
      ],
      resolve
    ).dashboards;

    const round = appsJsonToDashboards(dashboardsToAppsJson(seeded), resolve).dashboards;
    expect(round[0].groups!.map((g) => [g.name, g.paramName, g.value])).toEqual(
      seeded[0].groups!.map((g) => [g.name, g.paramName, g.value])
    );
    expect(round[0].cards.map((c) => c.groups?.length)).toEqual(
      seeded[0].cards.map((c) => c.groups?.length)
    );
  });
});
