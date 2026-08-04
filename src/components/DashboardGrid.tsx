import GridLayout, { WidthProvider, type Layout } from "react-grid-layout/legacy";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import {
  GRID_COLS, GRID_ROW_HEIGHT, useDashboardStore,
} from "../stores/dashboardStore";
import WidgetCard from "./WidgetCard";
import { logError } from "../lib/logger";

const Grid = WidthProvider(GridLayout);

interface SimpleLayoutItem { i: string; x: number; y: number; w: number; h: number; }

// react-grid-layout's own layout items always carry its internal bookkeeping
// fields (moved, static, minW, maxW, isDraggable, resizeHandles, ...) on top
// of {i,x,y,w,h}, so a naive equality check against the plain layout we pass
// in never holds -- every mount and every tab switch would be misread as a
// real layout change and persisted. Comparing only the fields we actually
// store avoids that false positive and keeps writes limited to genuine
// drag/resize commits.
function layoutsEqual(
  a: readonly SimpleLayoutItem[], b: readonly SimpleLayoutItem[]
): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((item) => [item.i, item]));
  return a.every((item) => {
    const other = byId.get(item.i);
    return (
      other !== undefined &&
      other.x === item.x && other.y === item.y &&
      other.w === item.w && other.h === item.h
    );
  });
}

export default function DashboardGrid() {
  const dashboards = useDashboardStore((s) => s.dashboards);
  const activeId = useDashboardStore((s) => s.activeId);
  const updateLayouts = useDashboardStore((s) => s.updateLayouts);

  const dashboard = dashboards.find((d) => d.id === activeId);

  if (!dashboard) {
    return <div className="placeholder-box">No dashboard selected.</div>;
  }

  const layout: Layout = dashboard.cards.map((c) => ({
    i: c.uuid, x: c.layout.x, y: c.layout.y, w: c.layout.w, h: c.layout.h,
  }));

  return (
    <div className="dashboard-grid">
      <Grid
        layout={layout}
        cols={GRID_COLS}
        rowHeight={GRID_ROW_HEIGHT}
        margin={[8, 8]}
        draggableHandle=".card-title"
        onLayoutChange={(l: Layout) => {
          // One batched update per layout change, not one per grid item: N
          // concurrent per-card writes can complete out of order and persist
          // stale positions.
          const next = l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
          if (layoutsEqual(next, layout)) return;
          updateLayouts(next).catch((e) =>
            logError(`updateLayouts failed: ${String(e)}`)
          );
        }}
      >
        {dashboard.cards.map((c) => (
          <div key={c.uuid}>
            <WidgetCard card={c} />
          </div>
        ))}
      </Grid>
      {dashboard.cards.length === 0 && (
        <div className="empty-dash">
          Empty dashboard — add widgets from the library (left rail ⊞).
        </div>
      )}
    </div>
  );
}
