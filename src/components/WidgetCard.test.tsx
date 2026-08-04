import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardCard } from "../lib/types";
import WidgetCard from "./WidgetCard";
import { fetchWidgetData, fetchWidgetHtml } from "../lib/dataClient";
import { logError } from "../lib/logger";

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

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

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
  registryColumns = [
    { field: "name", headerName: "Name" },
    { field: "age", headerName: "Age" },
  ];
  vi.mocked(fetchWidgetData).mockResolvedValue([
    { name: "Alice", age: 30 },
    { name: "Bob", age: 25 },
  ]);
  backendsList = [BACKEND];
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

