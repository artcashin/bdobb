import { useHoverPanel } from "../hooks/useHoverPanel";
import { useDashboardStore } from "../stores/dashboardStore";

export interface LeftRailProps {
  onOpenLibrary(): void;
  onOpenBackends(): void;
  onOpenSettings(): void;
}

export default function LeftRail({
  onOpenLibrary, onOpenBackends, onOpenSettings,
}: LeftRailProps) {
  const panel = useHoverPanel({ collapseDelayMs: 300, sticky: false });
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const setActive = useDashboardStore((s) => s.setActive);

  return (
    <nav
      className={`left-rail ${panel.expanded ? "expanded" : ""}`}
      onMouseEnter={panel.onMouseEnter}
      onMouseLeave={panel.onMouseLeave}
      aria-label="Navigation rail"
    >
      <div className="rail-top">
        <div className="rail-item" title="Dashboards">
          <span className="rail-icon" aria-hidden="true">▦</span>
          {panel.expanded && <span>Dashboards</span>}
        </div>
        {panel.expanded && (
          <div className="rail-dash-list">
            {dashboards.map((d) => (
              <button
                key={d.id}
                className={d.id === activeId ? "active" : ""}
                onClick={() => setActive(d.id)}
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
        <button
          className="rail-item"
          title="Widget Library"
          aria-label="Widget Library"
          onClick={onOpenLibrary}
        >
          <span className="rail-icon" aria-hidden="true">⊞</span>
          {panel.expanded && <span>Widget Library</span>}
        </button>
      </div>
      <div className="rail-bottom">
        <button
          className="rail-item"
          title="Backends"
          aria-label="Backends"
          onClick={onOpenBackends}
        >
          <span className="rail-icon" aria-hidden="true">⛁</span>
          {panel.expanded && <span>Backends</span>}
        </button>
        <button
          className="rail-item"
          title="Settings"
          aria-label="Settings"
          onClick={onOpenSettings}
        >
          <span className="rail-icon" aria-hidden="true">⚙</span>
          {panel.expanded && <span>Settings</span>}
        </button>
      </div>
    </nav>
  );
}
