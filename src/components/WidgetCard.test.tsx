import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardCard } from "../lib/types";
import WidgetCard from "./WidgetCard";
import { fetchWidgetData, fetchWidgetHtml } from "../lib/dataClient";
import { logError } from "../lib/logger";
import { shareWidgetToSymphony } from "../lib/chatShare";

// The store's removeCard is async (Promise<void>); the card chains .catch on
// it, so the mock must hand back a promise like the real action does.
const mockRemoveCard = vi.fn(() => Promise.resolve());
const mockUpdateCardView = vi.fn(() => Promise.resolve());
const mockUpdateCardParams = vi.fn(() => Promise.resolve());
const mockSetGroupValue = vi.fn(() => Promise.resolve());

// Dashboard state the card reads for parameter groups. Tests that exercise
// grouping set these; everything else sees an ungrouped dashboard.
let storeDashboards: any[] = [{ id: "d1", name: "Main", cards: [], groups: [] }];
let storeActiveId = "d1";

vi.mock("../stores/dashboardStore", () => ({
  GRID_COLS: 60,
  useDashboardStore: (selector: (s: any) => any) => {
    return selector({
      dashboards: storeDashboards,
      activeId: storeActiveId,
      removeCard: mockRemoveCard,
      updateCardView: mockUpdateCardView,
      updateCardParams: mockUpdateCardParams,
      setGroupValue: mockSetGroupValue,
    });
  },
}));

function widgetFixture(widgetId: string, type = "table") {
  return {
    id: widgetId,
    name: "Test Widget",
    description: "",
    category: "Test",
    subCategory: null,
    type,
    endpoint: "/test",
    gridData: { w: 20, h: 12 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: null,
    columnsDefs: [
      { field: "name", headerName: "Name" },
      { field: "age", headerName: "Age" },
    ],
    mcpUrl: null,
    backendId: "b1",
  };
}

// The registry is keyed by backend: a lookup with the wrong backendId must
// miss. A mock that matched any backendId previously hid a bug where the card
// passed "" and every card on the grid rendered blank.
let registryType = "table";
let registryParams: unknown[] = [];
let registryColumns: unknown = [
  { field: "name", headerName: "Name" },
  { field: "age", headerName: "Age" },
];
// Overrides widgetFixture's hardcoded `raw: false`. Needed to prove the keys
// guard is a real type check and not just riding on the server already
// setting raw: false for keys widgets (Task 4) — a card must not offer or
// honour "raw" for a keys widget even when the server flag says it may.
let registryRaw = false;
/**
 * Cache keyed like the real store. registryStore.find returns an element of the
 * widgets array, so its identity is stable across renders; a mock that built a
 * fresh object per call made WidgetCard's fetch effect see a new `widget`
 * dependency on every render and refetch forever — an artifact that would mask
 * a genuine loop rather than expose one.
 */
const registryCache = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../stores/registryStore", () => ({
  useRegistryStore: (selector: (s: any) => any) => selector({
    find: (backendId: string, widgetId: string) => {
      if (backendId !== "b1") return undefined;
      if (widgetId === "missing_widget") return undefined;
      const key = `${backendId}|${widgetId}`;
      if (!registryCache.has(key)) {
        registryCache.set(key, {
          ...widgetFixture(widgetId, registryType),
          columnsDefs: registryColumns,
          params: registryParams,
          raw: registryRaw,
        });
      }
      return registryCache.get(key);
    },
  }),
}));

const BACKEND = {
  id: "b1",
  name: "Test NAS",
  baseUrl: "https://nas.example",
  headerName: "x-api-key",
  headerValue: "secret",
};

let backendsList: unknown[] = [BACKEND];
vi.mock("../stores/backendsStore", () => ({
  useBackendsStore: (selector: (s: any) => any) => selector({ backends: backendsList }),
}));

// App-level Symphony settings the Task 5 wiring reads. Empty by default so
// every pre-existing test (written before settings existed) sees the same
// "" partnerId and card-supplied pod it always did.
let settingsFixture: {
  symphonyPodUrl: string;
  symphonyPartnerId: string;
  symphonyBridgeUrl: string;
} = {
  symphonyPodUrl: "",
  symphonyPartnerId: "",
  symphonyBridgeUrl: "",
};
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: (selector: (s: any) => any) => selector({ settings: settingsFixture }),
}));

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

vi.mock("../lib/chatShare", () => ({
  shareWidgetToSymphony: vi.fn(async () => ({ target: "Symphony", detail: "HTTP 200" })),
}));

// Desk Finding 1 graft: force a real renderer throw inside the card body to
// prove the ErrorBoundary wired into WidgetCard catches it. The sentinel data
// value keeps every other metric-typed test rendering normally.
vi.mock("./renderers/MetricRenderer", () => ({
  default: ({ data }: { data: unknown }) => {
    if (data === 999) throw new Error("render exploded");
    return <div>metric-ok</div>;
  },
}));

vi.mock("../lib/dataClient", () => ({
  fetchWidgetData: vi.fn().mockResolvedValue([
    { name: "Alice", age: 30 },
    { name: "Bob", age: 25 },
  ]),
  fetchWidgetHtml: vi.fn().mockResolvedValue("<p>server html</p>"),
}));

function makeCard(over: Partial<DashboardCard> = {}): DashboardCard {
  return {
    uuid: "c1",
    widgetId: "w1",
    backendId: "b1",
    layout: { x: 0, y: 0, w: 20, h: 12 },
    params: {},
    view: "default",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storeDashboards = [{ id: "d1", name: "Main", cards: [], groups: [] }];
  storeActiveId = "d1";
  registryCache.clear();
  registryType = "table";
  registryParams = [];
  registryRaw = false;
  registryColumns = [
    { field: "name", headerName: "Name" },
    { field: "age", headerName: "Age" },
  ];
  vi.mocked(fetchWidgetData).mockResolvedValue([
    { name: "Alice", age: 30 },
    { name: "Bob", age: 25 },
  ]);
  backendsList = [BACKEND];
  settingsFixture = { symphonyPodUrl: "", symphonyPartnerId: "", symphonyBridgeUrl: "" };
});

describe("WidgetCard", () => {
  it("renders the widget name from the registry", async () => {
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => {
      expect(screen.getByText("Test Widget")).toBeInTheDocument();
    });
  });

  it("falls back to the widget id when the registry has no match", async () => {
    render(<WidgetCard card={makeCard({ widgetId: "missing_widget" })} />);
    await waitFor(() => {
      expect(screen.getByText("missing_widget")).toBeInTheDocument();
    });
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
  });

  it("does not resolve a widget registered under a different backend", async () => {
    render(<WidgetCard card={makeCard({ backendId: "other-backend" })} />);
    await waitFor(() => {
      expect(screen.getByText("w1")).toBeInTheDocument();
    });
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
  });

  it("renders fetched data", async () => {
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => {
      expect(screen.getByText(/Alice/i)).toBeInTheDocument();
    });
  });

  it("fetches using the card's own backend, including auth headers", async () => {
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());
    const [backendArg] = vi.mocked(fetchWidgetData).mock.calls[0];
    expect(backendArg).toEqual(BACKEND);
  });

  it("shows an error and does not fetch when the card's backend is not configured", async () => {
    backendsList = [];
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => {
      expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    });
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
  });

  it("fetches text rather than JSON for html widgets", async () => {
    registryType = "html";
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(vi.mocked(fetchWidgetHtml)).toHaveBeenCalled());
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
  });

  it("does not fetch a JSON payload for iframe widgets", async () => {
    registryType = "iframe";
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWidgetHtml)).not.toHaveBeenCalled();
  });

  it("calls removeCard on close button click", async () => {
    render(<WidgetCard card={makeCard()} />);
    screen.getByRole("button", { name: /Remove widget/i }).click();
    expect(mockRemoveCard).toHaveBeenCalledWith("c1");
  });

  // .card-hover-panel is position:absolute top:4px right:4px z-index:2 -- the
  // exact corner .card-actions occupies. Measured against the real stylesheet,
  // the panel spanned x 351-415 while the Remove button sat at 383-411, so the
  // panel covered it completely and swallowed the click. Its own X was
  // onClick={close} ("Hide controls"), so hitting the visible X dismissed the
  // panel and left the widget on the dashboard. Trimming the panel's contents
  // does not help: with only the Refresh button it still spanned 383-415.
  it("puts nothing on top of the Remove button while the card is hovered", async () => {
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    fireEvent.mouseEnter(document.querySelector(".widget-card")!);

    expect(document.querySelector(".card-hover-panel")).toBeNull();

    const crosses = screen
      .getAllByRole("button")
      .filter((b) => b.textContent?.includes("\u2715"));
    expect(crosses).toHaveLength(1);
    expect(crosses[0]).toHaveAttribute("aria-label", "Remove widget");

    crosses[0].click();
    expect(mockRemoveCard).toHaveBeenCalledWith("c1");
  });

  describe("table <-> chart toggle", () => {
    const OHLC = [
      { date: "2026-07-01", open: 1, high: 2, low: 0.5, close: 1.5 },
      { date: "2026-07-02", open: 1.5, high: 3, low: 1.4, close: 2.8 },
    ];

    it("offers the chart view for a table declaring a date column", async () => {
      registryColumns = [{ field: "date", headerName: "Date" }, { field: "close" }];
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByTitle("View mode")).toBeInTheDocument());
      const options = Array.from(screen.getByTitle("View mode").querySelectorAll("option")).map(
        (o) => o.textContent
      );
      expect(options).toContain("Chart");
    });

    it("offers it when the rows yield a figure even without columnsDefs", async () => {
      // Most widgets.json entries omit columnsDefs entirely.
      registryColumns = null;
      vi.mocked(fetchWidgetData).mockResolvedValue(OHLC);
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => {
        const options = Array.from(screen.getByTitle("View mode").querySelectorAll("option")).map(
          (o) => o.textContent
        );
        expect(options).toContain("Chart");
      });
    });

    it("does not offer it for a table with no date column", async () => {
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByText(/Alice/)).toBeInTheDocument());
      // Asserted on the option rather than the select: with only "Default"
      // available the selector is hidden entirely, which is also "not offered".
      expect(screen.queryByRole("option", { name: "Chart" })).not.toBeInTheDocument();
    });

    it("renders a chart, not a table, when the chart view is selected", async () => {
      // renderContent used to dispatch on widget.type alone, so choosing
      // "Chart" changed the persisted field and nothing on screen.
      vi.mocked(fetchWidgetData).mockResolvedValue(OHLC);
      render(<WidgetCard card={makeCard({ view: "chart" })} />);
      await waitFor(() => {
        expect(document.querySelector(".chart-container")).toBeInTheDocument();
      });
      expect(document.querySelector("table")).toBeNull();
    });

    it("persists the selection through updateCardView", async () => {
      registryColumns = [{ field: "date" }, { field: "close" }];
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByTitle("View mode")).toBeInTheDocument());
      fireEvent.change(screen.getByTitle("View mode"), { target: { value: "chart" } });
      expect(mockUpdateCardView).toHaveBeenCalledWith("c1", "chart");
    });

    it("renders the chart view for a chart-type widget left on the default view (Task 7 carry)", async () => {
      // A widget whose declared type is "chart" must show its chart without
      // the user ever touching the view select.
      registryType = "chart";
      vi.mocked(fetchWidgetData).mockResolvedValue(OHLC);
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => {
        expect(document.querySelector(".chart-container")).toBeInTheDocument();
      });
      expect(document.querySelector("table")).toBeNull();
    });

    it("offers the Chart option for a chart-type widget even when the rows yield no figure", async () => {
      // `chartable` must OR the declared type in — a chart widget whose
      // current payload happens not to chart still IS a chart widget.
      registryType = "chart";
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByTitle("View mode")).toBeInTheDocument());
      const options = Array.from(screen.getByTitle("View mode").querySelectorAll("option")).map(
        (o) => o.textContent
      );
      expect(options).toContain("Chart");
    });

    it("logs a failed view persistence instead of leaving an unhandled rejection", async () => {
      // Desk Finding 1 graft (view-write branch): the store write is
      // fire-and-forget by design, so its rejection must land in the log.
      registryColumns = [{ field: "date" }, { field: "close" }];
      mockUpdateCardView.mockRejectedValueOnce(new Error("disk full"));
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByTitle("View mode")).toBeInTheDocument());
      fireEvent.change(screen.getByTitle("View mode"), { target: { value: "chart" } });
      await waitFor(() => {
        expect(vi.mocked(logError)).toHaveBeenCalledWith(
          expect.stringMatching(/updateCardView failed/)
        );
      });
    });
  });

  describe("per-card parameters", () => {
    const SYMBOL_PARAM = {
      paramName: "symbol",
      type: "text",
      value: "AAPL",
      label: "Symbol",
      description: "Ticker",
      show: true,
      multiSelect: false,
      options: null,
      optionsEndpoint: null,
      optionsParams: null,
    };

    it("offers no parameter control when the widget has none", async () => {
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
      expect(screen.queryByLabelText("Edit parameters")).not.toBeInTheDocument();
    });

    it("hides the panel for params the protocol marks not shown", async () => {
      // show: false means "sent but not user-editable".
      registryParams = [{ ...SYMBOL_PARAM, show: false }];
      render(<WidgetCard card={makeCard()} />);
      await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
      expect(screen.queryByLabelText("Edit parameters")).not.toBeInTheDocument();
    });

    it("opens an editor seeded with the card's current values", async () => {
      registryParams = [SYMBOL_PARAM];
      render(<WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />);
      await waitFor(() => expect(screen.getByLabelText("Edit parameters")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Edit parameters"));
      expect((screen.getByLabelText(/Symbol/) as HTMLInputElement).value).toBe("MSFT");
    });

    it("persists an edit through updateCardParams on Apply", async () => {
      // updateCardParams existed with no caller, so a card's params were fixed
      // at creation and could never be changed.
      registryParams = [SYMBOL_PARAM];
      render(<WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />);
      await waitFor(() => expect(screen.getByLabelText("Edit parameters")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Edit parameters"));
      fireEvent.change(screen.getByLabelText(/Symbol/), { target: { value: "NVDA" } });
      fireEvent.click(screen.getByText("Apply"));

      expect(mockUpdateCardParams).toHaveBeenCalledWith("c1", { symbol: "NVDA" });
    });

    it("discards the edit on Cancel", async () => {
      registryParams = [SYMBOL_PARAM];
      render(<WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />);
      await waitFor(() => expect(screen.getByLabelText("Edit parameters")).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText("Edit parameters"));
      fireEvent.change(screen.getByLabelText(/Symbol/), { target: { value: "NVDA" } });
      fireEvent.click(screen.getByText("Cancel"));

      expect(mockUpdateCardParams).not.toHaveBeenCalled();
      // Reopening shows the stored value, not the abandoned draft.
      fireEvent.click(screen.getByLabelText("Edit parameters"));
      expect((screen.getByLabelText(/Symbol/) as HTMLInputElement).value).toBe("MSFT");
    });

    it("refetches with the new params once they are applied", async () => {
      registryParams = [SYMBOL_PARAM];
      const { rerender } = render(<WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />);
      await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());
      vi.mocked(fetchWidgetData).mockClear();

      // The store would hand the card back with new params; simulate that.
      rerender(<WidgetCard card={makeCard({ params: { symbol: "NVDA" } })} />);
      // An effect queued by the previous render can land first, so assert the
      // new params are eventually used rather than pinning the call index.
      await waitFor(() => {
        const used = vi.mocked(fetchWidgetData).mock.calls.map(([, , v]) => v);
        expect(used).toContainEqual({ symbol: "NVDA" });
      });
    });

    it("ignores a slow earlier response that lands after a newer one", async () => {
      // Widget fetches are not cancellable. Changing params leaves two in
      // flight, and the earlier one used to resolve last and overwrite the
      // fresher payload, leaving the card showing data for parameters the
      // controls no longer displayed. The mock is keyed on the params rather
      // than call order, because the effect can legitimately fire more than
      // once per params value.
      registryParams = [SYMBOL_PARAM];
      let releaseStale: (v: unknown) => void = () => {};
      vi.mocked(fetchWidgetData).mockImplementation((_b, _w, values) => {
        const symbol = (values as { symbol?: string }).symbol;
        if (symbol === "MSFT") {
          return new Promise((resolve) => {
            releaseStale = resolve;
          });
        }
        return Promise.resolve([{ name: "Fresh", age: 1 }]);
      });

      const { rerender } = render(
        <WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />
      );
      await waitFor(() =>
        expect(vi.mocked(fetchWidgetData).mock.calls.some(([, , v]) =>
          (v as { symbol?: string }).symbol === "MSFT")).toBe(true)
      );

      rerender(<WidgetCard card={makeCard({ params: { symbol: "NVDA" } })} />);
      await waitFor(() => expect(screen.getByText("Fresh")).toBeInTheDocument());

      // The superseded MSFT request only now comes back.
      await act(async () => {
        releaseStale([{ name: "Stale", age: 99 }]);
      });

      expect(screen.getByText("Fresh")).toBeInTheDocument();
      expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    });
  });
});

describe("WidgetCard parameter groups", () => {
  const GROUP = { id: "g1", name: "Group 1", paramName: "symbol", value: "AAPL" };
  const SYMBOL_PARAM = {
    paramName: "symbol",
    type: "text",
    value: "MSFT",
    label: "Symbol",
    description: "Ticker",
    show: true,
    multiSelect: false,
    options: null,
    optionsEndpoint: null,
    optionsParams: null,
  };

  beforeEach(() => {
    registryParams = [SYMBOL_PARAM];
    storeDashboards = [{ id: "d1", name: "Main", cards: [], groups: [GROUP] }];
  });

  it("fetches with the group's value, not the card's own", async () => {
    render(
      <WidgetCard card={makeCard({ params: { symbol: "MSFT" }, groups: ["g1"] })} />
    );
    await waitFor(() => {
      const used = vi.mocked(fetchWidgetData).mock.calls.map(([, , v]) => v);
      expect(used).toContainEqual({ symbol: "AAPL" });
    });
    expect(
      vi.mocked(fetchWidgetData).mock.calls.map(([, , v]) => v)
    ).not.toContainEqual({ symbol: "MSFT" });
  });

  it("writes an edited shared parameter to the group, not the card", async () => {
    // Persisting it on the card would store a value the group masks on the
    // next render, so the control would snap back and the edit look lost.
    render(
      <WidgetCard card={makeCard({ params: { symbol: "MSFT" }, groups: ["g1"] })} />
    );
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText("Edit parameters"));
    fireEvent.change(screen.getByLabelText(/Symbol/), { target: { value: "NVDA" } });
    fireEvent.click(screen.getByText("Apply"));

    expect(mockSetGroupValue).toHaveBeenCalledWith("g1", "NVDA");
    // The card keeps no copy of a grouped parameter.
    expect(mockUpdateCardParams).toHaveBeenCalledWith("c1", {});
  });

  it("marks a shared control so the blast radius is visible", () => {
    render(
      <WidgetCard card={makeCard({ params: { symbol: "MSFT" }, groups: ["g1"] })} />
    );
    fireEvent.click(screen.getByLabelText("Edit parameters"));
    expect(screen.getByText(/\(shared\)/)).toBeInTheDocument();
  });

  it("leaves an ungrouped card's own parameter alone", async () => {
    render(<WidgetCard card={makeCard({ params: { symbol: "MSFT" } })} />);
    await waitFor(() => {
      const used = vi.mocked(fetchWidgetData).mock.calls.map(([, , v]) => v);
      expect(used).toContainEqual({ symbol: "MSFT" });
    });
    fireEvent.click(screen.getByLabelText("Edit parameters"));
    expect(screen.queryByText(/\(shared\)/)).not.toBeInTheDocument();
  });
});

describe("WidgetCard built-in widgets", () => {
  it("renders a note without fetching anything", async () => {
    // The defining property: a built-in has no backend, so a card holding one
    // must never reach the network — and must render even when no backend is
    // configured at all.
    backendsList = [];
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:note",
          backendId: "builtin",
          params: { text: "# Desk note" },
        })}
      />
    );
    expect(await screen.findByRole("heading", { name: "Desk note" })).toBeInTheDocument();
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWidgetHtml)).not.toHaveBeenCalled();
    expect(screen.queryByText(/is not configured/)).not.toBeInTheDocument();
    backendsList = [BACKEND];
  });

  it("persists an edited note onto the card", async () => {
    render(
      <WidgetCard
        card={makeCard({ widgetId: "builtin:note", backendId: "builtin", params: { text: "old" } })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Edit note/ }));
    const box = screen.getByLabelText("Note text");
    fireEvent.change(box, { target: { value: "new" } });
    fireEvent.blur(box);

    expect(mockUpdateCardParams).toHaveBeenCalledWith("c1", { text: "new" });
  });

  it("renders a clock without fetching anything", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:clock",
          backendId: "builtin",
          params: { zones: "America/New_York,Asia/Tokyo" },
        })}
      />
    );
    expect(screen.getByText("New York")).toBeInTheDocument();
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
  });

  it("still honours a card saved with the pre-select hour12 boolean", () => {
    // hourCycle replaced a boolean; a card saved on 12-hour must not flip back.
    const { container } = render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:clock",
          backendId: "builtin",
          params: { zones: "America/New_York", hour12: true },
        })}
      />
    );
    expect(container.querySelector(".clock-meridiem")).not.toBeNull();
  });

  it("still honours a card saved with the pre-list timezone param", () => {
    // The widget used to take a single `timezone`. A card created then must
    // keep showing its zone rather than silently reverting to the defaults.
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:clock",
          backendId: "builtin",
          params: { timezone: "Asia/Tokyo" },
        })}
      />
    );
    expect(screen.getByText("Tokyo")).toBeInTheDocument();
    expect(screen.queryByText("New York")).not.toBeInTheDocument();
  });

  it("still renders the vertical digital list for a card saved with no layout param", () => {
    // Every card saved before this feature has no `layout` key at all; it
    // must keep rendering the original digital list rather than switching to
    // the new horizontal analog tiles.
    const { container } = render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:clock",
          backendId: "builtin",
          params: { zones: "America/New_York,Asia/Tokyo" },
        })}
      />
    );
    expect(container.querySelector(".clock-list")).not.toBeNull();
    expect(container.querySelector(".clock-gallery")).toBeNull();
  });

  it("renders horizontal analog tiles when the card requests layout: horizontal", () => {
    const { container } = render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:clock",
          backendId: "builtin",
          params: { zones: "America/New_York,Asia/Tokyo", layout: "horizontal" },
        })}
      />
    );
    expect(container.querySelector(".clock-gallery")).not.toBeNull();
    expect(container.querySelectorAll(".clock-tile").length).toBeGreaterThan(0);
  });

  it("frames a website from a card parameter without fetching", () => {
    backendsList = [];
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:website",
          backendId: "builtin",
          params: { url: "https://example.com/page" },
        })}
      />
    );
    expect(screen.getByTitle("Website")).toHaveAttribute("src", "https://example.com/page");
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    backendsList = [BACKEND];
  });

  it("renders a Symphony iframe from card params, mapped to SymphonyRenderer's shape, without fetching", () => {
    backendsList = [];
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: {
            podUrl: "my-pod.symphony.com",
            streamId: "stream-1",
            mode: "focus",
            theme: "dark",
          },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      "https://my-pod.symphony.com/embed/index.html?streamId=stream-1&partnerId=&mode=focus&theme=dark&condensed=true"
    );
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    backendsList = [BACKEND];
  });

  it("strips a leading https:// scheme from the pod URL before framing it", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "https://my-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  it("strips a leading http:// scheme from the pod URL before framing it", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "http://my-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  it("strips a trailing slash from the pod URL before framing it", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "my-pod.symphony.com/", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  // Fix 4 (final review): an uppercase scheme defeated the case-sensitive
  // strip and produced "https://https//host/embed/..." -- a misdirected
  // request under the plan's origin-pinned-URLs constraint, not cosmetics.
  it("strips an uppercase scheme from the pod URL before framing it", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "HTTPS://my-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  it("strips leading/trailing whitespace from the pod URL before framing it", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "  my-pod.symphony.com  ", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  it("strips whitespace, an uppercase scheme, and a trailing slash together", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "  HTTPS://my-pod.symphony.com/  ", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/my-pod\.symphony\.com\/embed\//)
    );
  });

  it("passes an empty partnerId when settings.symphonyPartnerId is unset", () => {
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "my-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringContaining("partnerId=&")
    );
  });

  // Task 5 owns wiring the real partnerId in -- Task 2/3 shipped it as a
  // hardcoded "" because there was nowhere to source it from yet.
  it("passes partnerId from settings.symphonyPartnerId", () => {
    settingsFixture = { symphonyPodUrl: "", symphonyPartnerId: "partner-9", symphonyBridgeUrl: "" };
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "my-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      "https://my-pod.symphony.com/embed/index.html?streamId=stream-1&partnerId=partner-9&mode=&theme=&condensed=true"
    );
  });

  it("prefers the card's own podUrl param over settings.symphonyPodUrl", () => {
    settingsFixture = { symphonyPodUrl: "settings-pod.symphony.com", symphonyPartnerId: "", symphonyBridgeUrl: "" };
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { podUrl: "card-pod.symphony.com", streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/card-pod\.symphony\.com\/embed\//)
    );
  });

  it("falls back to settings.symphonyPodUrl when the card's own podUrl param is empty", () => {
    settingsFixture = { symphonyPodUrl: "settings-pod.symphony.com", symphonyPartnerId: "", symphonyBridgeUrl: "" };
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/settings-pod\.symphony\.com\/embed\//)
    );
  });

  it("normalizes settings.symphonyPodUrl the same way as a card-supplied pod (strips scheme and trailing slash)", () => {
    settingsFixture = { symphonyPodUrl: "https://settings-pod.symphony.com/", symphonyPartnerId: "", symphonyBridgeUrl: "" };
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:symphony",
          backendId: "builtin",
          params: { streamId: "stream-1" },
        })}
      />
    );
    expect(screen.getByTitle("Symphony")).toHaveAttribute(
      "src",
      expect.stringMatching(/^https:\/\/settings-pod\.symphony\.com\/embed\//)
    );
  });

  it("offers no refresh control for a built-in", () => {
    render(
      <WidgetCard card={makeCard({ widgetId: "builtin:clock", backendId: "builtin" })} />
    );
    // Nothing to re-request.
    expect(screen.queryByLabelText("Refresh widget")).not.toBeInTheDocument();
  });
});

describe("WidgetCard fetch hardening (desk graft)", () => {
  it("passes a real AbortSignal and aborts the superseded request on a param change", async () => {
    const cardA = makeCard({ params: { symbol: "MSFT" } });
    const { rerender } = render(<WidgetCard card={cardA} />);
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());
    const firstSignal = vi.mocked(fetchWidgetData).mock.calls[0][5];
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect((firstSignal as AbortSignal).aborted).toBe(false);

    // A rerender with a NEW card object but the SAME params reference must
    // neither refetch nor abort — otherwise this test would pass on any
    // rerender and prove nothing about param changes (fetchParams resolves to
    // card.params by reference when the card has no groups).
    rerender(<WidgetCard card={{ ...cardA }} />);
    expect(vi.mocked(fetchWidgetData)).toHaveBeenCalledTimes(1);
    expect((firstSignal as AbortSignal).aborted).toBe(false);

    // An actual param change is what supersedes the in-flight request.
    rerender(<WidgetCard card={{ ...cardA, params: { symbol: "NVDA" } }} />);
    await waitFor(() =>
      expect(vi.mocked(fetchWidgetData).mock.calls.length).toBeGreaterThanOrEqual(2)
    );
    expect((firstSignal as AbortSignal).aborted).toBe(true);

    const calls = vi.mocked(fetchWidgetData).mock.calls;
    const secondSignal = calls[calls.length - 1][5];
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(secondSignal).not.toBe(firstSignal);
    expect((secondSignal as AbortSignal).aborted).toBe(false);
  });

  it("aborts the in-flight request on unmount", async () => {
    const { unmount } = render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());
    const signal = vi.mocked(fetchWidgetData).mock.calls[0][5] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it("aborts the previous in-flight request when Refresh supersedes it", async () => {
    // A never-resolving first fetch: only the abort can end it.
    let firstSignal: AbortSignal | undefined;
    vi.mocked(fetchWidgetData).mockImplementationOnce(
      (_backend, _widget, _values, _opts, _fetch, signal) => {
        firstSignal = signal;
        return new Promise(() => {});
      }
    );
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(firstSignal).toBeInstanceOf(AbortSignal));

    fireEvent.click(screen.getByLabelText("Refresh widget"));
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalledTimes(2));
    expect(firstSignal!.aborted).toBe(true);
    await waitFor(() => expect(screen.getByText(/Alice/)).toBeInTheDocument());
  });

  it("shows and logs a fetch failure, then recovers on refresh", async () => {
    vi.mocked(fetchWidgetData)
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce([{ name: "Recovered", age: 1 }]);
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument());
    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED")
    );
    fireEvent.click(screen.getByLabelText("Refresh widget"));
    await waitFor(() => expect(screen.getByText("Recovered")).toBeInTheDocument());
  });

  it("fetches JSON with raw:true, not text, for an html widget in the raw view", async () => {
    // Desk useWidgetData Finding 3 intent: the raw view wants the endpoint's
    // JSON form even for widgets whose rendered form is text.
    registryType = "html";
    render(<WidgetCard card={makeCard({ view: "raw" })} />);
    await waitFor(() => expect(vi.mocked(fetchWidgetData)).toHaveBeenCalled());
    expect(vi.mocked(fetchWidgetHtml)).not.toHaveBeenCalled();
    expect(vi.mocked(fetchWidgetData).mock.calls[0][3]).toMatchObject({ raw: true });
  });
});

describe("WidgetCard keys widget secrecy (Task 6)", () => {
  it("never shows the raw view for a keys widget, even if the card asks for it", async () => {
    // A card's view can be persisted as "raw" from before the keys widget
    // type existed (or by hand-edited storage). Without a client-side type
    // guard, WidgetCard's raw branch fires before the type dispatch below it
    // and would dump the fetched envelope — including a tier-3 `value`
    // secret — straight into the DOM via RawJsonView.
    registryType = "keys";
    vi.mocked(fetchWidgetData).mockResolvedValue({
      tier: 3,
      rows: [
        {
          provider: "OpenAI",
          env_var: "OPENAI_API_KEY",
          status: "set",
          demo: false,
          value: "sk-should-never-leak",
        },
      ],
    });
    render(<WidgetCard card={makeCard({ view: "raw" })} />);
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument());

    // The keys table rendered (KeysRenderer), not the raw JSON dump.
    expect(document.querySelector(".raw-json-view")).toBeNull();
    expect(document.querySelector(".table-container")).toBeInTheDocument();
    // Belt and suspenders: the secret value must not appear anywhere in the
    // rendered output, however it got there.
    expect(screen.queryByText(/sk-should-never-leak/)).not.toBeInTheDocument();
  });

  it("does not offer raw as an available view for a keys widget", async () => {
    // registryRaw: true simulates a server that (incorrectly, or on an old
    // deploy) still flags this widget raw-capable. availableViews must still
    // exclude "raw" for a keys widget on the type alone, not merely because
    // the server said not to.
    registryType = "keys";
    registryRaw = true;
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: "Raw" })).not.toBeInTheDocument();
  });

  it("does not dump the raw envelope in the error-boundary fallback for a keys widget, even when the renderer throws", async () => {
    // isKeysEnvelope only checks Array.isArray(data.rows), not the shape of
    // each row. A null row reaches KeysRenderer's per-row cells
    // (row.original.provider) and throws, which is caught here by
    // WidgetCard's ErrorBoundary. Its fallback used to render RawJsonView
    // with the full unfiltered fetched envelope whenever data !== null, with
    // no keys guard -- so a malformed row turned into every tier-3 `value`
    // in the response being dumped verbatim to the screen.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registryType = "keys";
    vi.mocked(fetchWidgetData).mockResolvedValue({
      tier: 3,
      rows: [
        {
          provider: "OpenAI",
          env_var: "OPENAI_API_KEY",
          status: "set",
          demo: false,
          value: "sk-should-never-leak-in-error-fallback",
        },
        null,
      ],
    });
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => {
      expect(screen.getByText("This widget failed to render.")).toBeInTheDocument();
    });
    // The fallback must not fall through to the raw dump for a keys widget.
    expect(document.querySelector(".raw-json-view")).toBeNull();
    // Belt and suspenders: the secret value must not appear anywhere in the
    // rendered output, however it got there.
    expect(screen.queryByText(/sk-should-never-leak-in-error-fallback/)).not.toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});

describe("WidgetCard renderer error containment (desk graft)", () => {
  it("degrades a renderer throw to a single error card while sibling cards survive", async () => {
    // React logs the caught error; keep the test output pristine.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registryType = "metric";
    vi.mocked(fetchWidgetData).mockImplementation((_backend, w) =>
      Promise.resolve((w as { id: string }).id === "boom" ? 999 : 5)
    );
    render(
      <>
        <WidgetCard card={makeCard({ uuid: "c-boom", widgetId: "boom" })} />
        <WidgetCard card={makeCard({ uuid: "c-ok", widgetId: "ok" })} />
      </>
    );
    await waitFor(() => {
      expect(screen.getByText("This widget failed to render.")).toBeInTheDocument();
    });
    expect(screen.getByText("render exploded")).toBeInTheDocument();
    // The sibling card's own render survives untouched — proof the throw was
    // contained to one card, not the whole tree.
    expect(screen.getByText("metric-ok")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});

describe("Send to Symphony", () => {
  const sendButton = () => screen.getByRole("button", { name: /send to symphony/i });

  it("is absent when no Symphony bridge URL is configured", async () => {
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /send to symphony/i })).not.toBeInTheDocument();
  });

  it("appears for a table widget once a bridge URL is configured", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
  });

  it("appears for a chart widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    registryType = "chart";
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
  });

  it("appears for a markdown widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    registryType = "markdown";
    vi.mocked(fetchWidgetHtml).mockResolvedValue("**hi**");
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
  });

  it("appears for the built-in Note widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    render(
      <WidgetCard
        card={makeCard({ widgetId: "builtin:note", backendId: "builtin", params: { text: "hi" } })}
      />
    );
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
  });

  it("is absent for a widget type with no defined payload shape (e.g. metric)", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    registryType = "metric";
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /send to symphony/i })).not.toBeInTheDocument();
  });

  it("is absent for an iframe widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    registryType = "iframe";
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText("Test Widget")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /send to symphony/i })).not.toBeInTheDocument();
  });

  it("prompts for a stream ID and does nothing when the user cancels", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
    fireEvent.click(sendButton());
    expect(promptSpy).toHaveBeenCalled();
    expect(vi.mocked(shareWidgetToSymphony)).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("does nothing when the user submits a blank stream ID", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("   ");
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
    fireEvent.click(sendButton());
    expect(vi.mocked(shareWidgetToSymphony)).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("sends fetched rows and columns for a table widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("stream-42");
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText(/Alice/i)).toBeInTheDocument());
    fireEvent.click(sendButton());
    await waitFor(() => expect(vi.mocked(shareWidgetToSymphony)).toHaveBeenCalled());
    const [input] = vi.mocked(shareWidgetToSymphony).mock.calls[0];
    expect(input).toMatchObject({
      kind: "table",
      bridgeUrl: "http://localhost:9911",
      streamId: "stream-42",
      data: [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ],
    });
    promptSpy.mockRestore();
  });

  it("sends the note's own text (not fetched data) for the built-in Note widget", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("stream-9");
    render(
      <WidgetCard
        card={makeCard({
          widgetId: "builtin:note",
          backendId: "builtin",
          params: { text: "hello *world*" },
        })}
      />
    );
    await waitFor(() => expect(sendButton()).toBeInTheDocument());
    fireEvent.click(sendButton());
    await waitFor(() => expect(vi.mocked(shareWidgetToSymphony)).toHaveBeenCalled());
    const [input] = vi.mocked(shareWidgetToSymphony).mock.calls[0];
    expect(input).toMatchObject({ kind: "note", streamId: "stream-9", data: "hello *world*" });
    expect(vi.mocked(fetchWidgetData)).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("shows a confirmation after a successful send", async () => {
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("stream-1");
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText(/Alice/i)).toBeInTheDocument());
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/Symphony: HTTP 200/)).toBeInTheDocument());
    promptSpy.mockRestore();
  });

  it("shows the failure reason and logs it when the send fails", async () => {
    vi.mocked(shareWidgetToSymphony).mockRejectedValueOnce(new Error("bot not in room"));
    settingsFixture = { ...settingsFixture, symphonyBridgeUrl: "http://localhost:9911" };
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("stream-1");
    render(<WidgetCard card={makeCard()} />);
    await waitFor(() => expect(screen.getByText(/Alice/i)).toBeInTheDocument());
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/Failed: bot not in room/)).toBeInTheDocument());
    expect(vi.mocked(logError)).toHaveBeenCalledWith(expect.stringContaining("bot not in room"));
    promptSpy.mockRestore();
  });
});

