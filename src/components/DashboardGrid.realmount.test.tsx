// Real-library mount/tab-switch regression coverage for the layoutsEqual
// guard in DashboardGrid.tsx (ported from desk's 66316e1, "stop spurious
// layout writes"). DashboardGrid.test.tsx and DashboardGrid.persist.test.tsx
// both mock "react-grid-layout/legacy" with a stub that never calls
// onLayoutChange itself -- neither exercises the one thing layoutsEqual
// actually exists to suppress: the REAL library's mount effect handing back
// a layout array (carrying its own bookkeeping fields -- moved, static,
// minW, maxW, isDraggable, resizeHandles, ...) whose {i,x,y,w,h} projection
// is value-identical to what's already stored.
//
// This is a SEPARATE file, matching desk's own file split, and for the same
// reason: mounting the real library file-wide is incompatible with the
// pass-through mock the other two DashboardGrid test files rely on for
// their own assertions (mocked cols/rowHeight-prop plumbing in
// DashboardGrid.test.tsx; a captured, manually-invoked onLayoutChange
// handler in DashboardGrid.persist.test.tsx) -- react-grid-layout/legacy is
// intentionally NOT mocked anywhere in this file.
//
// A "genuine change DOES persist" case is deliberately not attempted here
// against the real library: driving a pixel-accurate drag/resize through
// react-grid-layout in jsdom would require faking getBoundingClientRect,
// offsetParent, clientWidth/clientHeight, and the library's own
// pixel<->grid-unit conversion (same infeasibility desk's own
// DashboardGrid.persist.test.tsx documents for exactly this reason). That
// positive case is covered there instead, via a captured real onLayoutChange
// handler invoked with genuinely different geometry.
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../lib/types";

const saveDashboard = vi.fn(async (_d: Dashboard) => {});
const deleteDashboard = vi.fn(async (_id: string) => {});
const loadDashboards = vi.fn(async (): Promise<Dashboard[]> => []);

vi.mock("../lib/persistence", () => ({
  loadDashboards: (...a: []) => loadDashboards(...a),
  saveDashboard: (d: Dashboard) => saveDashboard(d),
  deleteDashboard: (id: string) => deleteDashboard(id),
  // settingsStore reads this at module load; WidgetCard (imported by
  // DashboardGrid) now imports settingsStore for the Symphony settings
  // wiring, so this mock must export it too even though this file's own
  // tests don't otherwise touch settings.
  DEFAULT_SETTINGS: {
    ritaUrl: "", theme: "dark", contextSharing: false, mcpServers: [],
    symphonyPodUrl: "", symphonyPartnerId: "", symphonyBridgeUrl: "",
    symphonyDisplayName: "",
  },
}));

import DashboardGrid from "./DashboardGrid";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";

function seed(): void {
  useDashboardStore.setState({
    dashboards: [
      {
        id: "d1",
        name: "Main",
        cards: [
          {
            uuid: "c1", widgetId: "w1", backendId: "nas",
            layout: { x: 0, y: 0, w: 20, h: 8 }, params: {}, view: "default",
          },
          {
            uuid: "c2", widgetId: "w2", backendId: "nas",
            layout: { x: 20, y: 0, w: 20, h: 8 }, params: {}, view: "default",
          },
        ],
      },
    ],
    activeId: "d1",
  });
}

async function settle(): Promise<void> {
  // Flush the microtask queue enough times for RGL's mount effect and any
  // resulting store/persistence promises to resolve.
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  useRegistryStore.setState({ widgets: [], loading: false });
});

describe("DashboardGrid mount persistence (real react-grid-layout/legacy)", () => {
  it("does not persist the layout on mount when it already matches the stored layout", async () => {
    await act(async () => {
      render(<DashboardGrid />);
    });
    await settle();

    expect(saveDashboard).not.toHaveBeenCalled();
  });

  it("does not persist on a tab switch to a dashboard whose stored layout is already correct", async () => {
    useDashboardStore.setState((s) => ({
      dashboards: [
        ...s.dashboards,
        {
          id: "d2",
          name: "Macro",
          cards: [
            {
              uuid: "c3", widgetId: "w3", backendId: "nas",
              layout: { x: 0, y: 0, w: 10, h: 5 }, params: {}, view: "default",
            },
          ],
        },
      ],
    }));

    await act(async () => {
      render(<DashboardGrid />);
    });
    await settle();
    saveDashboard.mockClear();

    await act(async () => {
      useDashboardStore.getState().setActive("d2");
    });
    await settle();

    expect(saveDashboard).not.toHaveBeenCalled();
  });
});
