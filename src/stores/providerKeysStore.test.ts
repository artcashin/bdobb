import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderKeysStore } from "./providerKeysStore";
import type { WidgetDef } from "../lib/types";

vi.mock("../lib/logger", () => ({
  logError: vi.fn(),
}));

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

  it("treats a key-maint response with no rows array as a failure, not zero rows, and falls back to probing", async () => {
    // A tier-gated response, an error body, or a proxy page can all come back
    // 200 with no `rows` array. Silently defaulting to [] would badge every
    // provider "keyed" -- confidently wrong.
    const fetchJsonImpl = vi.fn(async () => ({ tier: 2 })); // no rows at all
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
    // Not just unlisted-by-key-maint "keyed": this provider was never even
    // probed, so it must be honestly unknown.
    expect(s.statusFor("SomeOtherProvider")).toBe("unknown");
  });

  it("treats a key-maint response whose rows is present but not an array as a failure, and falls back to probing", async () => {
    const fetchJsonImpl = vi.fn(async () => ({ rows: "oops, a string" }));
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

  it("a superseded refresh wave stops probing further providers and never commits its results", async () => {
    // 6 providers, concurrency 4: workers grab A,B,C,D synchronously; E,F sit
    // in the queue. Nothing here is awaited before the assertion below, which
    // relies on that synchronous fan-out actually happening.
    const wave1Widgets = ["A", "B", "C", "D", "E", "F"].map((p, i) =>
      widget({ id: `w1-${i}`, source: [p] })
    );
    const resolvers: Record<string, () => void> = {};
    const fetchWidgetDataImpl = vi.fn((_b: unknown, w: WidgetDef) => {
      return new Promise((res) => {
        resolvers[w.source[0]] = () => res({ ok: true });
      });
    });

    const wave1 = useProviderKeysStore
      .getState()
      .refresh([apiBackend], wave1Widgets, { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    expect(fetchWidgetDataImpl).toHaveBeenCalledTimes(4); // A,B,C,D grabbed; E,F still queued

    // A second refresh supersedes wave 1 before it can make further progress.
    const gWidget = widget({ id: "g", source: ["G"] });
    const wave2 = useProviderKeysStore
      .getState()
      .refresh([apiBackend], [gWidget], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });
    resolvers.G();
    await wave2;
    expect(useProviderKeysStore.getState().statusFor("G")).toBe("keyed");
    expect(useProviderKeysStore.getState().source).toBe("probe");

    // Now let wave 1's in-flight probes resolve. Superseded results must not
    // land, and E/F -- still queued when wave 1 went stale -- must never be
    // probed at all.
    resolvers.A();
    resolvers.B();
    resolvers.C();
    resolvers.D();
    await wave1;

    expect(useProviderKeysStore.getState().statusFor("A")).toBe("unknown");
    expect(useProviderKeysStore.getState().statusFor("G")).toBe("keyed"); // unclobbered
    expect(useProviderKeysStore.getState().source).toBe("probe");
    expect(fetchWidgetDataImpl).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "w1-4" }), // E
      expect.anything()
    );
    expect(fetchWidgetDataImpl).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "w1-5" }), // F
      expect.anything()
    );
  });

  it("commits results incrementally, so one hung backend doesn't block badges for providers that already answered", async () => {
    const fast = widget({ id: "fast", source: ["Fast"] });
    const hung = widget({ id: "hung", source: ["Hung"] });
    const fetchWidgetDataImpl = vi.fn((_b: unknown, w: WidgetDef) => {
      if (w.id === "hung") return new Promise(() => {}); // never resolves
      return Promise.resolve({ ok: true });
    });

    // refresh() itself may never settle (the hung provider blocks it), so
    // this must not be awaited -- only the store's state is checked.
    void useProviderKeysStore
      .getState()
      .refresh([apiBackend], [fast, hung], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    await vi.waitFor(() => {
      expect(useProviderKeysStore.getState().statusFor("Fast")).toBe("keyed");
    });
  });

  it("aborts the previous wave's in-flight requests when a new refresh starts", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetchWidgetDataImpl = vi.fn((..._args: unknown[]) => {
      signals.push(_args[5] as AbortSignal | undefined);
      return new Promise(() => {}); // never resolves
    });
    const wA = widget({ id: "a", source: ["A"] });
    useProviderKeysStore
      .getState()
      .refresh([apiBackend], [wA], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]!.aborted).toBe(false);

    const wB = widget({ id: "b", source: ["B"] });
    useProviderKeysStore
      .getState()
      .refresh([apiBackend], [wB], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    expect(signals[0]!.aborted).toBe(true);
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
