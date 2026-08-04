import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GRID_COLS, GRID_ROW_HEIGHT, useDashboardStore } from "../stores/dashboardStore";
import DashboardGrid from "./DashboardGrid";

// vi.mock factories are hoisted above module scope, so the props capture has
// to be hoisted with them.
const gridMock = vi.hoisted(() => ({ props: null as any }));

// Must match the component's import specifier — mocking "react-grid-layout"
// while the component imports "react-grid-layout/legacy" resolves to a
// different module, so the mock silently never applies.
vi.mock("react-grid-layout/legacy", () => ({
  WidthProvider: (Component: React.ComponentType) => Component,
  default: (props: any) => {
    gridMock.props = props;
    return (
      <div data-testid="mock-grid" data-cols={props.cols} data-row-height={props.rowHeight}>
        {props.children}
      </div>
    );
  },
}));

vi.mock("../stores/registryStore", () => ({
  useRegistryStore: (selector: (s: any) => any) => selector({
    find: (_backendId: string, widgetId: string) => ({
      id: widgetId,
      name: widgetId,
      description: "",
      category: "Test",
      subCategory: null,
      type: "table",
      endpoint: "/test",
      gridData: { w: 20, h: 12 },
      source: [],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: null,
      backendId: "b1",
    }),
  }),
}));

vi.mock("../stores/backendsStore", () => ({
  useBackendsStore: (selector: (s: any) => any) => selector({
    backends: [{ id: "b1", name: "Test", baseUrl: "https://nas.example" }],
  }),
}));

vi.mock("../lib/dataClient", () => ({
  fetchWidgetData: vi.fn().mockResolvedValue([]),
  fetchWidgetHtml: vi.fn().mockResolvedValue(""),
}));

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

function seed(cards: any[]) {
  const dashboards = [{ id: "d1", name: "Test", cards }] as any;
  useDashboardStore.setState({ dashboards, activeId: "d1" });
}

const CARD = {
  uuid: "c1",
  widgetId: "w1",
  backendId: "b1",
  layout: { x: 0, y: 0, w: 20, h: 12 },
  params: {},
  view: "default" as const,
};

beforeEach(() => {
  gridMock.props = null;
  useDashboardStore.setState({ dashboards: [], activeId: null });
});

describe("DashboardGrid", () => {
  it("renders a card per dashboard card", async () => {
    seed([CARD]);
    render(<DashboardGrid />);
    await waitFor(() => {
      expect(screen.getByText("w1")).toBeInTheDocument();
    });
  });

  it("passes the module's grid constants to the grid", () => {
    seed([CARD]);
    render(<DashboardGrid />);
    const grid = screen.getByTestId("mock-grid");
    expect(grid.getAttribute("data-cols")).toBe(String(GRID_COLS));
    expect(grid.getAttribute("data-row-height")).toBe(String(GRID_ROW_HEIGHT));
  });

  it("persists a layout change as a single batched update", async () => {
    seed([CARD, { ...CARD, uuid: "c2", layout: { x: 0, y: 12, w: 20, h: 12 } }]);
    render(<DashboardGrid />);

    gridMock.props.onLayoutChange([
      { i: "c1", x: 10, y: 10, w: 30, h: 20 },
      { i: "c2", x: 5, y: 40, w: 15, h: 6 },
    ]);

    await waitFor(() => {
      const cards = useDashboardStore.getState().active()!.cards;
      expect(cards.find((c) => c.uuid === "c1")!.layout).toEqual({ x: 10, y: 10, w: 30, h: 20 });
    });
    const cards = useDashboardStore.getState().active()!.cards;
    expect(cards.find((c) => c.uuid === "c2")!.layout).toEqual({ x: 5, y: 40, w: 15, h: 6 });
  });

  it("shows empty state when the dashboard has no cards", () => {
    seed([]);
    render(<DashboardGrid />);
    expect(screen.getByText(/Empty dashboard/i)).toBeInTheDocument();
  });

  it("shows a neutral placeholder, not an error box, when no dashboard is active", () => {
    // Desk (66316e1): "no dashboard selected" is a transient/empty state, not
    // a failure -- rendering it as .error-box read as the app being broken.
    useDashboardStore.setState({ dashboards: [], activeId: "nonexistent" });
    render(<DashboardGrid />);
    expect(screen.getByText(/No dashboard selected/i)).toBeInTheDocument();
    expect(document.querySelector(".error-box")).not.toBeInTheDocument();
  });
});
