import { useState } from "react";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import { importAppsJson, exportAppsJson } from "../lib/appsJsonFile";
import { findBuiltin } from "../lib/builtins";
import { logError } from "../lib/logger";

export default function DashboardTabs() {
  const [notice, setNotice] = useState<string | null>(null);
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);
  const addDashboards = useDashboardStore((s) => s.addDashboards);
  const saveError = useDashboardStore((s) => s.saveError);
  const dismissSaveError = useDashboardStore((s) => s.dismissSaveError);

  /**
   * apps.json names widgets by id alone — Workspace resolves them across every
   * connected backend, so the importer has to do the same. First match wins
   * when two backends publish the same id; there is nothing in the file to
   * disambiguate with.
   */
  const resolveWidget = (widgetId: string) => {
    // Built-ins first: they belong to no backend and are never in the
    // registry, so without this a note or clock exported from BDOBB would come
    // back reported as a widget no backend provides.
    const builtin = findBuiltin(widgetId);
    if (builtin) return { backendId: builtin.backendId, widget: builtin };

    const widget = useRegistryStore
      .getState()
      .widgets.find((w) => w.id === widgetId);
    return widget ? { backendId: widget.backendId, widget } : null;
  };

  const handleImport = async () => {
    setNotice(null);
    try {
      const result = await importAppsJson(resolveWidget);
      if (!result) return; // cancelled
      await addDashboards(result.dashboards);

      // Report what did not survive. An import that silently drops half a
      // dashboard looks like the app losing data.
      const parts = [`Imported ${result.dashboards.length} dashboard(s).`];
      if (result.unresolved.length > 0) {
        const ids = [...new Set(result.unresolved.map((u) => u.widgetId))];
        parts.push(
          `${result.unresolved.length} widget(s) skipped — no connected backend ` +
            `provides: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? "…" : ""}.`
        );
      }
      parts.push(...result.warnings);
      setNotice(parts.join(" "));
    } catch (e) {
      logError(`apps.json import failed: ${String(e)}`);
      setNotice(e instanceof Error ? e.message : "Import failed.");
    }
  };

  const handleExport = async () => {
    setNotice(null);
    try {
      const path = await exportAppsJson(dashboards, {
        exportedAt: new Date().toISOString(),
      });
      if (path) setNotice(`Exported ${dashboards.length} dashboard(s) to ${path}`);
    } catch (e) {
      logError(`apps.json export failed: ${String(e)}`);
      setNotice("Export failed.");
    }
  };

  // Dashboards in source order, split into app sections. Preserving order
  // rather than sorting keeps an imported app's tabs in the order its author
  // arranged them.
  const sections: { appName: string | undefined; items: typeof dashboards }[] = [];
  for (const d of dashboards) {
    const last = sections[sections.length - 1];
    if (last && last.appName === d.appName) last.items.push(d);
    else sections.push({ appName: d.appName, items: [d] });
  }

  const renderTab = (d: (typeof dashboards)[number]) => (
        <div key={d.id} className={`dash-tab ${d.id === activeId ? "active" : ""}`}>
          <button
            className="dash-tab-name"
            onClick={() => setActive(d.id)}
            onDoubleClick={() => {
              const name = window.prompt("Rename dashboard", d.name);
              if (name) {
                renameDashboard(d.id, name).catch((e) =>
                  logError(`renameDashboard failed: ${String(e)}`)
                );
              }
            }}
          >
            {d.name}
          </button>
          {dashboards.length > 1 && (
            <button
              className="dash-tab-close"
              title="Delete dashboard"
              aria-label={`Delete dashboard ${d.name}`}
              onClick={() => {
                if (window.confirm(`Delete dashboard "${d.name}"?`)) {
                  removeDashboard(d.id).catch((e) =>
                    logError(`removeDashboard failed: ${String(e)}`)
                  );
                }
              }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
  );

  return (
    <>
      {/* Finding 2 (desk dc4664b): every dashboard mutation is optimistic --
          the UI updates before the disk write is even attempted, and a
          rejected write used to be log-only. This is the one place in the
          shell that is always on screen regardless of which dashboard is
          active, so it's where a failed write becomes visible instead of
          silently vanishing on restart. */}
      {saveError && (
        <div className="save-error-banner" role="alert">
          <span>⚠ {saveError}</span>
          <button
            title="Dismiss"
            aria-label="Dismiss save error"
            onClick={dismissSaveError}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}
      <div className="dash-tabs">
        {sections.map((section, i) =>
          section.appName ? (
            // A named app becomes a labelled section, so the tabs of an imported
            // app read as one thing rather than as unrelated siblings.
            <div
              key={`${section.appName}-${i}`}
              className="dash-app"
              role="group"
              aria-label={`App: ${section.appName}`}
            >
              <span className="dash-app-name" title={section.appName}>
                {section.appName}
              </span>
              {section.items.map(renderTab)}
            </div>
          ) : (
            <div key={`ungrouped-${i}`} className="dash-app ungrouped">
              {section.items.map(renderTab)}
            </div>
          )
        )}
        <button
          className="dash-tab-add"
          title="New dashboard"
          aria-label="New dashboard"
          onClick={() => {
            const name = window.prompt("New dashboard name", "Untitled");
            if (name) {
              addDashboard(name).catch((e) =>
                logError(`addDashboard failed: ${String(e)}`)
              );
            }
          }}
        >
          <span aria-hidden="true">+</span>
        </button>
        <span className="dash-tabs-spacer" />
        <button
          className="dash-tab-io"
          title="Import an OpenBB Workspace apps.json"
          onClick={handleImport}
        >
          Import
        </button>
        <button
          className="dash-tab-io"
          title="Export dashboards as an OpenBB Workspace apps.json"
          onClick={handleExport}
          disabled={dashboards.length === 0}
        >
          Export
        </button>
        {notice && (
          <span className="dash-tabs-notice" role="status">
            {notice}
            <button
              className="dash-tabs-notice-close"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </span>
        )}
      </div>
    </>
  );
}
