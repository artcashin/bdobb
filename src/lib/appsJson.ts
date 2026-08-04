import type { Dashboard, DashboardCard, ParamGroup, ParamValues, WidgetDef } from "./types";
import { initialParamValues } from "./params";
import { newId } from "./uuid";
import { GRID_COLS } from "../stores/dashboardStore";

/**
 * OpenBB Workspace's apps.json — the one portable representation of a
 * dashboard the hosted product exposes. Workspace stores dashboards
 * server-side against an account, but will export one to this format
 * ("Export apps.json" on a dashboard's context menu) and will import a
 * backend's /apps.json. That makes it the interchange format between
 * pro.openbb.co and BDOBB in both directions.
 *
 * A Workspace *app* holds named tabs; a tab holds a grid layout. A tab is what
 * BDOBB calls a dashboard, and a layout entry is what it calls a card.
 */
export interface AppsJsonLayoutItem {
  /** Widget id — matches a key in the backend's widgets.json. */
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Names of the app-level groups this card participates in. */
  groups?: string[];
  state?: Record<string, unknown>;
}

export interface AppsJsonTab {
  id: string;
  name: string;
  layout: AppsJsonLayoutItem[];
}

/** A shared parameter value. Workspace scopes these to an app. */
export interface AppsJsonGroup {
  name: string;
  /** "param" or "endpointParam" — describes the parameter's kind, not the link. */
  type?: string;
  paramName: string;
  defaultValue?: unknown;
}

export interface AppsJsonApp {
  name: string;
  description?: string;
  img?: string;
  img_dark?: string;
  img_light?: string;
  allowCustomization?: boolean;
  tabs: Record<string, AppsJsonTab>;
  groups?: AppsJsonGroup[];
}

/**
 * Workspace lays out on a 40-column grid; BDOBB uses 60. Importing coordinates
 * unscaled would squeeze every dashboard into the left two-thirds of the
 * screen, and exporting unscaled would push cards off the right edge in
 * Workspace.
 *
 * Inferred from the reference corpus rather than from a published number: across
 * its 70 widgets in 14 tabs, max(x + w) is exactly 40 and full-width widgets are
 * w:40. If OpenBB changes the grid, this is the one constant to update.
 */
export const WORKSPACE_GRID_COLS = 40;

/**
 * Scale a column *position*. Distinct from scaleWidth because 0 is a valid
 * position — the leftmost column — but never a valid width, and clamping the
 * two the same way shifts every card one column out of place.
 */
function scalePos(value: number, from: number, to: number): number {
  return Math.max(0, Math.min(to - 1, Math.round((value * to) / from)));
}

/** Scale a column span. At least one column wide, never wider than the grid. */
function scaleWidth(value: number, from: number, to: number): number {
  return Math.max(1, Math.min(to, Math.round((value * to) / from)));
}

/**
 * Rows are left unscaled deliberately. A column is a fraction of the window
 * width, so it converts exactly; a row is a fixed pixel height (24px here) and
 * Workspace does not publish its own. Preserving row values keeps vertical
 * ordering and relative heights intact, which is what a layout actually
 * depends on — absolute density may differ slightly.
 */
function isLayoutItem(x: unknown): x is AppsJsonLayoutItem {
  if (x === null || typeof x !== "object") return false;
  const l = x as AppsJsonLayoutItem;
  return (
    typeof l.i === "string" &&
    l.i !== "" &&
    typeof l.x === "number" &&
    typeof l.y === "number" &&
    typeof l.w === "number" &&
    typeof l.h === "number"
  );
}

/** How a widget id resolves to a concrete backend, or null when it does not. */
export type WidgetResolver = (
  widgetId: string
) => { backendId: string; widget: WidgetDef } | null;

export interface ImportResult {
  dashboards: Dashboard[];
  /**
   * Widgets named by the file that no connected backend provides. Reported
   * rather than dropped silently: importing a Workspace dashboard whose
   * widgets come from a backend the user has not added should say so, not
   * produce a mysteriously half-empty grid.
   */
  unresolved: { dashboard: string; widgetId: string }[];
  /** Set when the file uses Workspace features BDOBB cannot represent. */
  warnings: string[];
}

/**
 * Converts an apps.json document into dashboards.
 *
 * Tolerant by design: this is a file the user picked, possibly hand-edited or
 * produced by a Workspace version newer than this code. A malformed tab is
 * skipped with a warning rather than failing the whole import, because
 * recovering 13 of 14 dashboards beats recovering none.
 */
export function appsJsonToDashboards(raw: unknown, resolve: WidgetResolver): ImportResult {
  const unresolved: ImportResult["unresolved"] = [];
  const warnings: string[] = [];
  const dashboards: Dashboard[] = [];

  // Workspace exports a bare array; a backend's /apps.json serves the same.
  // A single object is accepted too, since that is what hand-editing tends to
  // produce.
  const apps: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  if (apps.length === 0) {
    warnings.push("No apps found in the file.");
    return { dashboards, unresolved, warnings };
  }

  for (const appRaw of apps) {
    if (appRaw === null || typeof appRaw !== "object") continue;
    const app = appRaw as AppsJsonApp;
    const appName = typeof app.name === "string" ? app.name : "Imported app";

    const tabs = app.tabs;
    if (tabs === null || typeof tabs !== "object") {
      warnings.push(`"${appName}" has no tabs.`);
      continue;
    }

    // Workspace scopes groups to the app; BDOBB scopes them to a dashboard.
    // A group referenced from several tabs therefore becomes one independent
    // group per dashboard — cards still move together within a dashboard, but
    // a change no longer reaches across to another. Narrower than the format
    // allows, and warned about, rather than spooky action between dashboards.
    const appGroups = Array.isArray(app.groups) ? app.groups : [];
    const groupUseCount = new Map<string, number>();
    for (const t of Object.values(tabs)) {
      if (t === null || typeof t !== "object" || !Array.isArray(t.layout)) continue;
      const namesInTab = new Set<string>();
      for (const item of t.layout) {
        if (!isLayoutItem(item) || !Array.isArray(item.groups)) continue;
        for (const n of item.groups) if (typeof n === "string") namesInTab.add(n);
      }
      for (const n of namesInTab) groupUseCount.set(n, (groupUseCount.get(n) ?? 0) + 1);
    }
    const spanning = [...groupUseCount.entries()].filter(([, n]) => n > 1).map(([n]) => n);
    if (spanning.length > 0) {
      warnings.push(
        `Parameter group(s) ${spanning.join(", ")} are shared across several tabs. ` +
          `BDOBB scopes a group to one dashboard, so each dashboard gets its own copy ` +
          `and they no longer update together.`
      );
    }

    for (const tab of Object.values(tabs)) {
      if (tab === null || typeof tab !== "object" || !Array.isArray(tab.layout)) continue;

      // The tab keeps its own name; the app it came from is recorded on the
      // dashboard instead of being flattened into the name. Prefixing was how
      // this was disambiguated before dashboards could say which app they
      // belong to.
      const name = typeof tab.name === "string" && tab.name ? tab.name : tab.id;

      // One ParamGroup per app group actually referenced in this tab.
      const groupIdByName = new Map<string, string>();
      const dashboardGroups: ParamGroup[] = [];
      for (const g of appGroups) {
        if (g === null || typeof g !== "object" || typeof g.paramName !== "string") continue;
        if (typeof g.name !== "string") continue;
        const referenced = tab.layout.some(
          (i) => isLayoutItem(i) && Array.isArray(i.groups) && i.groups.includes(g.name)
        );
        if (!referenced) continue;
        const id = newId();
        groupIdByName.set(g.name, id);
        dashboardGroups.push({
          id,
          name: g.name,
          paramName: g.paramName,
          value: (g.defaultValue ?? null) as ParamValues[string],
        });
      }

      const cards: DashboardCard[] = [];
      for (const item of tab.layout) {
        if (!isLayoutItem(item)) continue;

        const found = resolve(item.i);
        if (!found) {
          unresolved.push({ dashboard: name, widgetId: item.i });
          continue;
        }

        cards.push({
          uuid: newId(),
          widgetId: found.widget.id,
          backendId: found.backendId,
          layout: (() => {
            const x = scalePos(item.x, WORKSPACE_GRID_COLS, GRID_COLS);
            return {
              x,
              y: Math.max(0, Math.round(item.y)),
              // Keep the card on the grid: a width scaled up from a card that
              // sat flush against Workspace's right edge can otherwise overhang.
              w: Math.min(scaleWidth(item.w, WORKSPACE_GRID_COLS, GRID_COLS), GRID_COLS - x),
              h: Math.max(3, Math.round(item.h)),
            };
          })(),
          // apps.json carries no parameter values, so cards start on the
          // widget's own defaults — the same state as adding one by hand.
          params: initialParamValues(found.widget),
          view: found.widget.type === "chart" ? "chart" : "default",
          groups: (Array.isArray(item.groups) ? item.groups : [])
            .map((n) => (typeof n === "string" ? groupIdByName.get(n) : undefined))
            .filter((id): id is string => id !== undefined),
        });
      }

      dashboards.push({
        id: newId(),
        name,
        appName,
        cards,
        // Only groups something on this dashboard actually uses.
        groups: dashboardGroups.filter((g) =>
          cards.some((c) => c.groups?.includes(g.id))
        ),
      });
    }
  }

  return { dashboards, unresolved, warnings };
}

/**
 * Converts dashboards into an apps.json document Workspace can import.
 *
 * One app holding one tab per dashboard, which is the shape Workspace's own
 * export produces. Per-card params and view are not represented — apps.json
 * has no field for either, so a round trip through Workspace returns cards on
 * their widget defaults.
 */
export function dashboardsToAppsJson(
  dashboards: Dashboard[],
  opts: { name?: string; description?: string } = {}
): AppsJsonApp[] {
  const fallbackName = opts.name ?? "BDOBB export";

  // One app per distinct appName, preserving the grouping an import recorded.
  // Emitting everything as a single app would collapse several imported apps
  // into one on the way back to Workspace.
  const byApp = new Map<string, Dashboard[]>();
  for (const d of dashboards) {
    const key = d.appName?.trim() || fallbackName;
    byApp.set(key, [...(byApp.get(key) ?? []), d]);
  }

  return [...byApp.entries()].map(([appName, members]) => {
    const tabs: Record<string, AppsJsonTab> = {};
    const usedIds = new Set<string>();

    // Group names are the only handle a layout entry has, and groups are
    // app-level, so collisions must be resolved within each app.
    const appGroups: AppsJsonGroup[] = [];
    const exportedName = new Map<string, string>();
    const usedGroupNames = new Set<string>();
    for (const d of members) {
      for (const g of d.groups ?? []) {
        let name = g.name;
        for (let n = 2; usedGroupNames.has(name); n++) name = `${g.name} (${n})`;
        usedGroupNames.add(name);
        exportedName.set(g.id, name);
        appGroups.push({
          name,
          type: "param",
          paramName: g.paramName,
          defaultValue: g.value ?? undefined,
        });
      }
    }

    for (const d of members) {
      const base =
        d.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tab";
      let id = base;
      for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
      usedIds.add(id);

      tabs[id] = {
        id,
        name: d.name,
        layout: d.cards.map((c) => {
          const x = scalePos(c.layout.x, GRID_COLS, WORKSPACE_GRID_COLS);
          return {
            i: c.widgetId,
            x,
            y: c.layout.y,
            w: Math.min(
              scaleWidth(c.layout.w, GRID_COLS, WORKSPACE_GRID_COLS),
              WORKSPACE_GRID_COLS - x
            ),
            h: c.layout.h,
            groups: (c.groups ?? [])
              .map((id) => exportedName.get(id))
              .filter((n): n is string => n !== undefined),
          };
        }),
      };
    }

    return {
      name: appName,
      description:
        opts.description ??
        `Exported from BDOBB — ${members.length} dashboard${members.length === 1 ? "" : "s"}.`,
      allowCustomization: true,
      tabs,
      groups: appGroups,
    };
  });
}
