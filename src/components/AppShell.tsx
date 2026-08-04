import { useMemo, useState } from "react";
import DashboardGrid from "./DashboardGrid";
import DashboardTabs from "./DashboardTabs";
import ErrorBoundary from "./ErrorBoundary";
import LeftRail from "./LeftRail";
import BackendsDialog from "./dialogs/BackendsDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
import WidgetLibrary from "./WidgetLibrary";
import ParamControls from "./ParamControls";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import type { WidgetDef } from "../lib/types";
import { BUILTIN_WIDGETS } from "../lib/builtins";

export interface AppShellProps {
  /** Names of startup steps (settings/backends/dashboards) that failed to
   * load, from App.tsx's independent per-store startup effect. Optional so
   * render sites that don't care about startup failures work unchanged. */
  startupErrors?: string[];
}

export default function AppShell({ startupErrors = [] }: AppShellProps) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [widgetToSelect, setWidgetToSelect] = useState<WidgetDef | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string | number | boolean | string[] | null>>({});
  const [backendsOpen, setBackendsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const widgets = useRegistryStore((s) => s.widgets);
  const addCard = useDashboardStore((s) => s.addCard);

  const handleAddCard = () => {
    if (widgetToSelect) {
      addCard(widgetToSelect, widgetToSelect.backendId, undefined, paramValues);
      setWidgetToSelect(null);
      setParamValues({});
    }
  };

  // Built-ins are always offered — they need no backend, so they are the only
  // widgets available before one is configured.
  const widgetList = useMemo(() => [...BUILTIN_WIDGETS, ...widgets], [widgets]);

  return (
    <div className="app-shell">
      <LeftRail
        onOpenLibrary={() => setLibraryOpen((v) => !v)}
        onOpenBackends={() => setBackendsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-area">
        {/* Startup used to be an all-or-nothing chain whose only surface was
            the log. App.tsx loads each store independently; this names
            whichever ones actually failed instead of leaving the user to
            guess at a quietly empty dashboard. */}
        {startupErrors.length > 0 && (
          <div className="startup-error-banner" role="alert">
            Failed to load on startup: {startupErrors.join(", ")}. The app is
            still usable, but some data may be missing until this is fixed
            and the app restarted.
          </div>
        )}
        <DashboardTabs />
        <DashboardGrid />
      </main>
      {/* Each top-level pane/dialog gets its own boundary: a render throw in
          one degrades to a single error card instead of unmounting the whole
          React tree. WidgetCard was previously the only boundary anywhere. */}
      {libraryOpen && (
        <div className="library-panel">
          <ErrorBoundary label="the widget library">
            <WidgetLibrary
              widgets={widgetList}
              onSelectWidget={(widget) => {
                setWidgetToSelect(widget);
                setLibraryOpen(false);
              }}
              onClose={() => setLibraryOpen(false)}
            />
          </ErrorBoundary>
        </div>
      )}
      {widgetToSelect && (
        <div className="param-controls-panel">
          <ParamControls
            params={widgetToSelect.params || []}
            values={paramValues}
            onChange={setParamValues}
          />
          <div className="param-controls-actions">
            <button
              onClick={() => {
                setWidgetToSelect(null);
                setParamValues({});
              }}
            >
              Cancel
            </button>
            <button onClick={handleAddCard}>Add</button>
          </div>
        </div>
      )}
      <ErrorBoundary label="the backends dialog" resetKey={backendsOpen}>
        <BackendsDialog isOpen={backendsOpen} onClose={() => setBackendsOpen(false)} />
      </ErrorBoundary>
      <ErrorBoundary label="the settings dialog" resetKey={settingsOpen}>
        <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ErrorBoundary>
    </div>
  );
}
