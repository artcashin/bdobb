import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveGridRenderer from "./LiveGridRenderer";
import { makeWidgetDef } from "../../test/widgetDef";
import type { BackendConfig } from "../../lib/types";

// Only fetchJson is faked (the /symbol_meta logo lookup); URL builders and
// serializers stay real. Default: an empty answer, i.e. no logos.
const fetchJsonMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/dataClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/dataClient")>()),
  fetchJson: fetchJsonMock,
}));

/**
 * Stand-in for the browser WebSocket: records the URL it was given and what
 * was sent, and lets a test push server frames / drive open-close by hand.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // -- test drivers --
  serverOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const backend: BackendConfig = {
  id: "b1",
  name: "Live grid backend",
  baseUrl: "https://openbb.example.ts.net:6903",
};

const widget = () =>
  makeWidgetDef({
    id: "live_grid",
    type: "live_grid",
    endpoint: "/live_grid",
    wsEndpoint: "/live_grid_ws",
    wsRowIdColumn: "symbol",
    columnsDefs: [
      { field: "symbol", headerName: "Symbol", pinned: "left" },
      {
        field: "price",
        headerName: "Price",
        renderFn: "showCellChange",
        renderFnParams: { colorValueKey: "change" },
      },
      { field: "change_percent", headerName: "Chg %", renderFn: "greenRed", formatterFn: "percent" },
      { field: "volume", headerName: "Volume", enableCellChangeWs: false },
    ],
  });

const SEED = [
  { symbol: "AAPL", price: 150, change: 2, change_percent: 0.0135, volume: 1000 },
  { symbol: "BTC-USD", price: 60000, change: -500, change_percent: -0.0082, volume: 42 },
];

function lastSocket(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function renderGrid(over: Partial<Parameters<typeof LiveGridRenderer>[0]> = {}) {
  return render(
    <LiveGridRenderer
      data={SEED}
      widgetDef={widget()}
      backend={backend}
      params={{ symbol: "AAPL,BTC-USD" }}
      theme="dark"
      {...over}
    />
  );
}

describe("LiveGridRenderer", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    fetchJsonMock.mockReset();
    fetchJsonMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders the seed rows with the declared columns", () => {
    renderGrid();
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("BTC-USD")).toBeInTheDocument();
    expect(screen.getByText("Symbol")).toBeInTheDocument();
    // formatterFn percent applies to the seeded value.
    expect(screen.getByText("1.35%")).toBeInTheDocument();
  });

  it("dials wsEndpoint under the backend origin with the scheme swapped to wss", () => {
    renderGrid();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastSocket().url).toBe("wss://openbb.example.ts.net:6903/live_grid_ws");
  });

  it("sends the live_grid params message on open", () => {
    renderGrid();
    act(() => lastSocket().serverOpen());
    expect(lastSocket().sent).toEqual([
      JSON.stringify({ params: { symbol: "AAPL,BTC-USD" } }),
    ]);
  });

  it("re-sends params on the open socket when they change", () => {
    const view = renderGrid();
    act(() => lastSocket().serverOpen());
    view.rerender(
      <LiveGridRenderer
        data={SEED}
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL,MSFT" }}
        theme="dark"
      />
    );
    // Same socket (no re-dial), one message per params value.
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(lastSocket().sent).toEqual([
      JSON.stringify({ params: { symbol: "AAPL,BTC-USD" } }),
      JSON.stringify({ params: { symbol: "AAPL,MSFT" } }),
    ]);
  });

  it("merges a streamed row into the grid by wsRowIdColumn", () => {
    renderGrid();
    act(() => {
      lastSocket().serverOpen();
      lastSocket().serverMessage({ symbol: "AAPL", price: 151.5, change: 3.5 });
    });
    expect(screen.getByText("151.50")).toBeInTheDocument();
    // The other row is untouched.
    expect(screen.getByText("60,000")).toBeInTheDocument();
  });

  it("appends a streamed row whose symbol the seed never saw", () => {
    renderGrid();
    act(() => {
      lastSocket().serverOpen();
      lastSocket().serverMessage({ symbol: "MSFT", price: 420 });
    });
    expect(screen.getByText("MSFT")).toBeInTheDocument();
  });

  it("flashes a changed cell but never a column with enableCellChangeWs false", () => {
    const { container } = renderGrid();
    act(() => {
      lastSocket().serverOpen();
      lastSocket().serverMessage({ symbol: "AAPL", price: 151.5, volume: 2000 });
    });
    const flashes = Array.from(container.querySelectorAll(".cell-flash")).map(
      (el) => el.textContent
    );
    expect(flashes).toContain("151.50");
    // volume changed too, but its column opted out of the flash.
    expect(flashes).not.toContain("2,000");
    expect(screen.getByText("2,000")).toBeInTheDocument();
  });

  it("colors greenRed by the cell's own sign and showCellChange by colorValueKey", () => {
    const { container } = renderGrid();
    const cells = (cls: string) =>
      Array.from(container.querySelectorAll(`td.${cls}`)).map((el) => el.textContent);
    // change_percent: 1.35% is positive, -0.82% negative (greenRed).
    // price: colored by the sign of `change` (showCellChange) — +2 / -500.
    expect(cells("cell-pos")).toEqual(expect.arrayContaining(["1.35%", "150"]));
    expect(cells("cell-neg")).toEqual(expect.arrayContaining(["-0.82%", "60,000"]));
  });

  it("re-dials after the socket drops", () => {
    vi.useFakeTimers();
    renderGrid();
    act(() => lastSocket().serverOpen());
    act(() => lastSocket().close());
    expect(screen.getByText("reconnecting…")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("opens no socket when the widget has no wsEndpoint", () => {
    renderGrid({ widgetDef: makeWidgetDef({ type: "live_grid", wsEndpoint: null }) });
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("renders a symbol logo when /symbol_meta has one, none when it doesn't", async () => {
    fetchJsonMock.mockResolvedValue([
      { symbol: "AAPL", logo_url: "https://eodhd.com/img/logos/US/aapl.png" },
      { symbol: "BTC-USD", logo_url: null },
    ]);
    const { container } = renderGrid();
    await waitFor(() => {
      expect(container.querySelectorAll("img.cell-logo")).toHaveLength(1);
    });
    const img = container.querySelector("img.cell-logo") as HTMLImageElement;
    expect(img.src).toBe("https://eodhd.com/img/logos/US/aapl.png");
    expect(img.alt).toBe("");
    // requested from the widget's own backend, deduped symbols comma-joined
    const [url] = fetchJsonMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://openbb.example.ts.net:6903/symbol_meta?symbol=AAPL%2CBTC-USD"
    );
  });

  it("stays logo-free and calm when /symbol_meta fails (older backend)", async () => {
    fetchJsonMock.mockRejectedValue(new Error("HTTP 404"));
    const { container } = renderGrid();
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());
    expect(container.querySelectorAll("img.cell-logo")).toHaveLength(0);
    expect(screen.getByText("AAPL")).toBeInTheDocument();
  });

  it("shows the raw payload when the seed is not an array", () => {
    renderGrid({ data: { detail: "EODHD_API_KEY is not set" } });
    expect(screen.getByText(/EODHD_API_KEY/)).toBeInTheDocument();
  });
});
