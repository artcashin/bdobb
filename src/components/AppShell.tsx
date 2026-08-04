import { useEffect, useState, useMemo } from "react";
import DashboardGrid from "./DashboardGrid";
import DashboardTabs from "./DashboardTabs";
import ErrorBoundary from "./ErrorBoundary";
import LeftRail from "./LeftRail";
import RitaPane from "./RitaPane";
import { useChatStore } from "../stores/chatStore";
import ChatPane from "./chat/ChatPane";
import BackendsDialog from "./dialogs/BackendsDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
import WidgetLibrary from "./WidgetLibrary";
import AgentEditBar from "./AgentEditBar";
import ParamControls from "./ParamControls";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";
import type { WidgetDef } from "../lib/types";
import { BUILTIN_WIDGETS } from "../lib/builtins";
import { usePointerKind } from "../hooks/usePointerKind";

export interface AppShellProps {
  /** Names of startup steps (settings/backends/dashboards/chat) that failed
   * to load, from App.tsx's independent per-store startup effect (desk
   * dc4664b, Finding 3). Optional so every existing render site/test that
   * doesn't care about startup failures keeps working unchanged. */
  startupErrors?: string[];
}

export default function AppShell({ startupErrors = [] }: AppShellProps) {
  const pointerKind = usePointerKind();
    const [pinned, setPinned] = useState(false);
  const [chatSticky, setChatSticky] = useState(false);
  const hasUnread = useChatStore((s) => s.hasUnread);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [widgetToSelect, setWidgetToSelect] = useState<WidgetDef | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string | number | boolean | string[] | null>>({});
  const [backendsOpen, setBackendsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const widgets = useRegistryStore((s) => s.widgets);
  const addCard = useDashboardStore((s) => s.addCard);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // holding the shortcut must not thrash the toggle
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setPinned((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    // pointer-fine / pointer-coarse is the seam between the two interaction
    // paradigms. Today only styling reads it — hit targets and the hover
    // affordance — but it is also what a touch mode will branch on.
    <div className={`app-shell pointer-${pointerKind} ${pinned ? "rita-pinned" : ""}`}>
      <LeftRail
        onOpenLibrary={() => setLibraryOpen((v) => !v)}
        onOpenBackends={() => setBackendsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main-area">
        {/* Finding 3 (desk dc4664b): startup used to be an all-or-nothing
            chain -- one store's load failing (e.g. settingsStore.load()
            re-throwing on a permissions/full-disk mkdir failure) skipped
            the rest, and the only surface was DashboardGrid's neutral "No
            dashboard selected." App.tsx now loads each store independently
            so one failure can't starve the others; this names whichever
            ones actually failed instead of leaving the user to guess. */}
        {startupErrors.length > 0 && (
          <div className="startup-error-banner" role="alert">
            Failed to load on startup: {startupErrors.join(", ")}. The app is
            still usable, but some data may be missing until this is fixed
            and the app restarted.
          </div>
        )}
        <DashboardTabs />
        <AgentEditBar />
        <DashboardGrid />
      </main>
      {/* Finding 4 (desk dc4664b): these were the only top-level
          panes/dialogs NOT wrapped in an ErrorBoundary anywhere in the app
          -- WidgetCard was the sole existing use. A render throw in any one
          of them (a malformed SSE status update reaching ChatMessages, a
          settings.json that survives shape validation but still breaks
          SettingsDialog's `.map`, ...) used to take the whole React tree
          down instead of degrading to a single broken panel. */}
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
      <RitaPane
        pinned={pinned}
        sticky={chatSticky}
        unread={hasUnread}
        onTogglePin={() => setPinned((p) => !p)}
      >
        <ErrorBoundary label="the Rita chat pane">
          <ChatPane onStickyChange={setChatSticky} />
        </ErrorBoundary>
      </RitaPane>
    </div>
  );
}
