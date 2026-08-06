import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderKeysStore } from "./providerKeysStore";
import type { WidgetDef } from "../lib/types";

function widget(over: Partial<WidgetDef>): WidgetDef {
  return {
    id: "w",
    name: "W",
    description: "",
    category: "Cat",
    subCategory: null,
    type: "table",
    endpoint: "/api/v1/x",
    gridData: { w: 10, h: 10 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: "results",
    columnsDefs: [],
    mcpUrl: null,
    backendId: "api",
    ...over,
  } as WidgetDef;
}

const apiBackend = { id: "api", name: "OpenBB", baseUrl: "https://api.example" };
const kmBackend = { id: "km", name: "Keys", baseUrl: "https://keys.example" };
const kmWidget = widget({ id: "provider_api_keys", backendId: "km" });

beforeEach(() => {
  useProviderKeysStore.setState({ status: {}, source: "none" });
});

describe("providerKeysStore", () => {
  it("prefers key-maint: fetches /keys with that backend and parses rows", async () => {
    const fetchJsonImpl = vi.fn(async () => ({
      tier: 2,
      rows: [
        { provider: "EODHD", status: "set", demo: false },
        { provider: "FMP", status: "empty" },
      ],
    }));
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend, kmBackend], [kmWidget, widget({ id: "e", source: ["Eodhd"] })], {
        fetchJsonImpl: fetchJsonImpl as never,
      });

    expect(fetchJsonImpl).toHaveBeenCalledWith("https://keys.example/keys", kmBackend);
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("key-maint");
    expect(s.statusFor("Eodhd")).toBe("keyed");
    expect(s.statusFor("FMP")).toBe("unkeyed");
  });

  it("treats providers key-maint does not list as keyless -> keyed", async () => {
    const fetchJsonImpl = vi.fn(async () => ({ tier: 2, rows: [] }));
    await useProviderKeysStore
      .getState()
      .refresh([kmBackend], [kmWidget], { fetchJsonImpl: fetchJsonImpl as never });
    expect(useProviderKeysStore.getState().statusFor("YFinance")).toBe("keyed");
  });

  it("falls back to probes when there is no key-maint backend", async () => {
    const eodhd = widget({
      id: "e",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: "SPY" }] as WidgetDef["params"],
    });
    const alpaca = widget({ id: "a", source: ["Alpaca"] });
    const fetchWidgetDataImpl = vi.fn(async (_b, w: WidgetDef) => {
      if (w.id === "a") throw new Error('HTTP 400: {"detail":"Missing credential \'alpaca_api_key\'"}');
      return { ok: true };
    });

    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], [eodhd, alpaca], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("probe");
    expect(s.statusFor("Eodhd")).toBe("keyed");
    expect(s.statusFor("Alpaca")).toBe("unkeyed");
  });

  it("probe mode: ambiguous failures and unprobed providers stay unknown", async () => {
    const flaky = widget({ id: "f", source: ["Tiingo"] });
    const fetchWidgetDataImpl = vi.fn(async () => {
      throw new Error("HTTP 401: Not authenticated");
    });
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], [flaky], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });
    expect(useProviderKeysStore.getState().statusFor("Tiingo")).toBe("unknown");
    // never probed at all -> unknown, NOT the key-maint keyless default
    expect(useProviderKeysStore.getState().statusFor("Fmp")).toBe("unknown");
  });

  it("falls back to probes when the key-maint fetch fails", async () => {
    const fetchJsonImpl = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    const eodhd = widget({ id: "e", source: ["Eodhd"] });
    const fetchWidgetDataImpl = vi.fn(async () => ({ ok: true }));
    await useProviderKeysStore
      .getState()
      .refresh([kmBackend, apiBackend], [kmWidget, eodhd], {
        fetchJsonImpl: fetchJsonImpl as never,
        fetchWidgetDataImpl: fetchWidgetDataImpl as never,
      });
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("probe");
    expect(s.statusFor("Eodhd")).toBe("keyed");
  });

  it("with no backends at all the source is none and everything unknown", async () => {
    await useProviderKeysStore.getState().refresh([], []);
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("none");
    expect(s.statusFor("Eodhd")).toBe("unknown");
  });

  it("caps probe concurrency at 4", async () => {
    let inFlight = 0;
    let peak = 0;
    const widgets = ["A", "B", "C", "D", "E", "F"].map((p, i) =>
      widget({ id: `w${i}`, source: [p] })
    );
    const fetchWidgetDataImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {};
    });
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], widgets, { fetchWidgetDataImpl: fetchWidgetDataImpl as never });
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchWidgetDataImpl).toHaveBeenCalledTimes(6);
  });
});
