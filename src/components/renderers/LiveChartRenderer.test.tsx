import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Plotly from "plotly.js-dist-min";
import LiveChartRenderer from "./LiveChartRenderer";
import { makeWidgetDef } from "../../test/widgetDef";
import type { BackendConfig } from "../../lib/types";

vi.mock("plotly.js-dist-min", () => ({
  default: { react: vi.fn(), purge: vi.fn(), Plots: { resize: vi.fn() } },
}));

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
    id: "live_chart",
    type: "live_chart",
    endpoint: "/series",
    wsEndpoint: "/live_grid_ws",
  });

function bar(date: string, close: number, volume: number | null = 10) {
  return { date, open: close, high: close, low: close, close, volume };
}

function fetchImplFor(bySymbol: Record<string, unknown>) {
  return vi.fn(async (url: string | URL) => {
    const symbol = new URL(url).searchParams.get("symbol") ?? "";
    if (!(symbol in bySymbol)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify({ bars: bySymbol[symbol], cache: {} }), { status: 200 });
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lastSocket = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

describe("LiveChartRenderer", () => {
  it("seeds one /series call per symbol and draws a figure", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe("/series");
    expect(calledUrl.searchParams.get("symbol")).toBe("AAPL");
    expect(calledUrl.searchParams.get("interval")).toBe("1m");
  });

  it("isolates a per-symbol seed failure in small multiples -- other symbols still render", async () => {
    // Per-symbol errors only render distinctly in small-multiples (candle)
    // layout; the overlay layout silently omits a failed symbol from the
    // combined chart rather than showing inline error text.
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] }); // MSFT missing -> 404
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL,MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => expect(screen.getByText(/HTTP 404/i)).toBeInTheDocument());
    // AAPL's own mini chart still drew.
    expect(vi.mocked(Plotly.react)).toHaveBeenCalled();
  });

  it("subscribes over the shared websocket with the joined symbol list", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());
    expect(lastSocket().sent).toEqual([JSON.stringify({ params: { symbol: "AAPL" } })]);
  });

  it("buckets an incoming tick into the seeded series", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());
    const callsBefore = vi.mocked(Plotly.react).mock.calls.length;
    act(() => lastSocket().serverMessage({ symbol: "AAPL", price: 105, last_size: 3 }));
    await waitFor(() => expect(vi.mocked(Plotly.react).mock.calls.length).toBeGreaterThan(callsBefore));
    const calls = vi.mocked(Plotly.react).mock.calls;
    const [, data] = calls[calls.length - 1];
    const y = (data as { y: number[] }[])[0].y;
    expect(y[y.length - 1]).toBe(105);
  });

  it("switches chart type without re-fetching /series", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => {
      const calls = vi.mocked(Plotly.react).mock.calls;
      const [, data] = calls[calls.length - 1];
      expect((data as { type: string }[])[0].type).toBe("candlestick");
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still just the one seed call
  });

  it("renders small multiples for multi-symbol candle", async () => {
    const fetchImpl = fetchImplFor({
      AAPL: [bar("2026-08-07T00:00:00", 100)],
      MSFT: [bar("2026-08-07T00:00:00", 200)],
    });
    render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL,MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    // Default chartType is line, so this starts in overlay layout, where a
    // symbol name is a Plotly trace `name`, not visible DOM text -- wait for
    // the initial draw, then switch to candle to reach small multiples.
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    act(() => screen.getByRole("button", { name: /candle/i }).click());
    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
      expect(screen.getByText("MSFT")).toBeInTheDocument();
    });
  });

  it("re-seeds and resubscribes when the symbol list changes", async () => {
    const fetchImpl = fetchImplFor({
      AAPL: [bar("2026-08-07T00:00:00", 100)],
      MSFT: [bar("2026-08-07T00:00:00", 200)],
    });
    const { rerender } = render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());

    rerender(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "MSFT", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("symbol")).toBe("MSFT");
    const sent = lastSocket().sent;
    expect(sent[sent.length - 1]).toBe(JSON.stringify({ params: { symbol: "MSFT" } }));
  });

  it("re-seeds on an interval-only change but does not tear down the websocket", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    const { rerender } = render(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(lastSocket()).toBeDefined());
    act(() => lastSocket().serverOpen());
    const socketCountAfterOpen = MockWebSocket.instances.length;

    rerender(
      <LiveChartRenderer
        widgetDef={widget()}
        backend={backend}
        params={{ symbol: "AAPL", interval: "5m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    // Interval change still re-seeds (new /series call for the new interval)...
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const secondUrl = new URL(fetchImpl.mock.calls[1][0] as string);
    expect(secondUrl.searchParams.get("symbol")).toBe("AAPL");
    expect(secondUrl.searchParams.get("interval")).toBe("5m");
    // ...but the live websocket, whose subscribe payload only encodes the
    // symbol list, must not be torn down and reopened just because the
    // interval changed. The connection was never closed server-side.
    expect(MockWebSocket.instances.length).toBe(socketCountAfterOpen);
  });

  it("shows a static seed-only chart when the widget has no wsEndpoint", async () => {
    const fetchImpl = fetchImplFor({ AAPL: [bar("2026-08-07T00:00:00", 100)] });
    render(
      <LiveChartRenderer
        widgetDef={makeWidgetDef({ id: "live_chart", type: "live_chart", endpoint: "/series", wsEndpoint: null })}
        backend={backend}
        params={{ symbol: "AAPL", interval: "1m" }}
        theme="dark"
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />
    );
    await waitFor(() => expect(vi.mocked(Plotly.react)).toHaveBeenCalled());
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
