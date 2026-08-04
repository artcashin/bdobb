import { useMemo, useState } from "react";
import DashboardGrid from "./DashboardGrid";
import DashboardTabs from "./DashboardTabs";
import LeftRail from "./LeftRail";
import BackendsDialog from "./dialogs/BackendsDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
import WidgetLibrary from "./WidgetLibrary";
import ParamControls from "./ParamControls";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import type { WidgetDef } from "../lib/types";
import { BUILTIN_WIDGETS } from "../lib/builtins";

export default function AppShell() {
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
        <DashboardTabs />
        <DashboardGrid />
      </main>
      {libraryOpen && (
        <div className="library-panel">
          <WidgetLibrary
            widgets={widgetList}
            onSelectWidget={(widget) => {
              setWidgetToSelect(widget);
              setLibraryOpen(false);
            }}
            onClose={() => setLibraryOpen(false)}
          />
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
      <BackendsDialog isOpen={backendsOpen} onClose={() => setBackendsOpen(false)} />
      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
