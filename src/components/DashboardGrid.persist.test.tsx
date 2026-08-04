// Ported from desk (fb47f16, "cover drag-persist"). Finding 5, final review:
// every existing test in DashboardGrid.test.tsx asserts `saveDashboard` was
// NOT called (the negative "don't false-positive on mount/tab-switch" path).
// Nothing in the suite ever proved the OTHER half of spec criterion 4 -- that
// a genuine drag/resize actually reaches `updateLayouts`/`saveDashboard` with
// the new geometry. Hard-coding `layoutsEqual` (DashboardGrid.tsx) to `return
// true`, or deleting the `updateLayouts(next)` call in its `onLayoutChange`
// handler, passes the whole existing suite untouched.
//
// Driving a pixel-accurate real mouse drag through react-grid-layout in
// jsdom would additionally require faking `getBoundingClientRect`,
// `offsetParent`, `clientWidth`/`clientHeight`, and the library's own
// pixel<->grid-unit conversion. Per the review's own fallback clause, this
// file instead captures the real `onLayoutChange` callback DashboardGrid
// hands to `<Grid>` (only `react-grid-layout/legacy` is replaced with a thin
// pass-through stub -- matching the mock DashboardGrid.test.tsx already uses
// for the same import specifier; DashboardGrid's own code, incl.
// `layoutsEqual` and the `updateLayouts` call, is NOT mocked) and invokes it
// with a genuinely different layout, then asserts the persisted geometry.
// This is a separate file (not added to DashboardGrid.test.tsx) so the
// existing mount/tab-switch tests keep exercising the mocked grid's own
// prop-plumbing assertions -- mixing the two styles in one file would make
// this file's positive case redundant with that one's, or vice versa.
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
}));

type CapturedLayoutItem = { i: string; x: number; y: number; w: number; h: number };
type OnLayoutChange = (l: CapturedLayoutItem[]) => void;

// Captured from DashboardGrid's own `<Grid onLayoutChange={...}>` prop on
// every render, so the test always invokes whatever handler is CURRENTLY
// wired up (not a stale closure from an earlier render).
const onLayoutChangeRef: { current: OnLayoutChange | null } = { current: null };

// Must match the component's import specifier -- mocking "react-grid-layout"
// while the component imports "react-grid-layout/legacy" resolves to a
// different module, so the mock silently never applies.
vi.mock("react-grid-layout/legacy", () => ({
  WidthProvider: (Component: React.ComponentType) => Component,
  default: (props: {
    children: React.ReactNode;
    onLayoutChange?: OnLayoutChange;
  }) => {
    onLayoutChangeRef.current = props.onLayoutChange ?? null;
    return props.children;
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
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  onLayoutChangeRef.current = null;
  seed();
  useRegistryStore.setState({ widgets: [], loading: false });
});

describe("DashboardGrid persistence (real onLayoutChange handler)", () => {
  it("persists a genuine drag/resize to saveDashboard with the new geometry", async () => {
    await act(async () => {
      render(<DashboardGrid />);
    });
    await settle();
    saveDashboard.mockClear();

    expect(onLayoutChangeRef.current).not.toBeNull();

    // A drag that moved c1 and a resize that changed c2's height -- both
    // fields differ from the seeded layout, so layoutsEqual (if it's doing
    // its real job) must see this as a genuine change.
    await act(async () => {
      onLayoutChangeRef.current!([
        { i: "c1", x: 5, y: 2, w: 20, h: 8 },
        { i: "c2", x: 20, y: 0, w: 20, h: 12 },
      ]);
    });
    await settle();

    expect(saveDashboard).toHaveBeenCalledTimes(1);
    const persisted = saveDashboard.mock.calls[0][0] as Dashboard;
    const c1 = persisted.cards.find((c) => c.uuid === "c1");
    const c2 = persisted.cards.find((c) => c.uuid === "c2");
    expect(c1?.layout).toEqual({ x: 5, y: 2, w: 20, h: 8 });
    expect(c2?.layout).toEqual({ x: 20, y: 0, w: 20, h: 12 });
  });

  it("does not persist when onLayoutChange fires with the same geometry", async () => {
    await act(async () => {
      render(<DashboardGrid />);
    });
    await settle();
    saveDashboard.mockClear();

    await act(async () => {
      onLayoutChangeRef.current!([
        { i: "c1", x: 0, y: 0, w: 20, h: 8 },
        { i: "c2", x: 20, y: 0, w: 20, h: 8 },
      ]);
    });
    await settle();

    expect(saveDashboard).not.toHaveBeenCalled();
  });
});
