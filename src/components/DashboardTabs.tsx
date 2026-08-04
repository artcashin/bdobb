import { useDashboardStore } from "../stores/dashboardStore";
import { logError } from "../lib/logger";

export default function DashboardTabs() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);
  const addDashboard = useDashboardStore((s) => s.addDashboard);
  const renameDashboard = useDashboardStore((s) => s.renameDashboard);
  const removeDashboard = useDashboardStore((s) => s.removeDashboard);
  const saveError = useDashboardStore((s) => s.saveError);
  const dismissSaveError = useDashboardStore((s) => s.dismissSaveError);

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
        {dashboards.map(renderTab)}
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
      </div>
    </>
  );
}
