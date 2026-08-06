import { describe, expect, it } from "vitest";
import {
  badgeFor,
  classifyProbeError,
  defaultParamValues,
  findKeyMaintBackend,
  normalizeProvider,
  parseKeyMaintRows,
  pickProbeWidget,
  widgetProviders,
  MULTISOURCE_LABEL,
} from "./providerKeys";
import type { WidgetDef } from "./types";
import type { ProviderKeyStatus } from "./providerKeys";

/** Minimal WidgetDef factory — only the fields this module reads. */
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
    backendId: "b1",
    ...over,
  } as WidgetDef;
}

describe("normalizeProvider", () => {
  it("folds case, separators and parentheticals", () => {
    expect(normalizeProvider("EODHD")).toBe("eodhd");
    expect(normalizeProvider("Eodhd")).toBe("eodhd");
    expect(normalizeProvider("Alpha Vantage")).toBe("alphavantage");
    expect(normalizeProvider("Alpha_vantage")).toBe("alphavantage");
    expect(normalizeProvider("Alpaca (secret)")).toBe("alpaca");
    expect(normalizeProvider("Congress.gov")).toBe("congressgov");
  });
});

describe("parseKeyMaintRows", () => {
  it("maps set/empty/unknown statuses", () => {
    const out = parseKeyMaintRows([
      { provider: "EODHD", status: "set", demo: false },
      { provider: "FMP", status: "empty" },
      { provider: "Tiingo", status: "unknown" },
    ]);
    expect(out).toEqual({ eodhd: "keyed", fmp: "unkeyed", tiingo: "unknown" });
  });

  it("demo keys count as keyed", () => {
    expect(parseKeyMaintRows([{ provider: "FMP", status: "set", demo: true }])).toEqual({
      fmp: "keyed",
    });
  });

  it("keys a paired provider only when every row is set (alpaca)", () => {
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "empty" },
      ])
    ).toEqual({ alpaca: "unkeyed" });
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "set" },
      ])
    ).toEqual({ alpaca: "keyed" });
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "unknown" },
      ])
    ).toEqual({ alpaca: "unknown" });
  });
});

describe("findKeyMaintBackend", () => {
  const backends = [
    { id: "api", name: "OpenBB", baseUrl: "https://api.example" },
    { id: "km", name: "Keys", baseUrl: "https://keys.example" },
  ];

  it("finds the backend whose widgets include provider_api_keys", () => {
    const widgets = [
      widget({ id: "etf_x", backendId: "api" }),
      widget({ id: "provider_api_keys", backendId: "km" }),
    ];
    expect(findKeyMaintBackend(backends, widgets)?.id).toBe("km");
  });

  it("returns null when no backend serves it", () => {
    expect(findKeyMaintBackend(backends, [widget({ id: "etf_x", backendId: "api" })])).toBeNull();
  });
});

describe("classifyProbeError", () => {
  it("reads a missing credential as unkeyed", () => {
    expect(
      classifyProbeError(new Error("HTTP 400 from x: {\"detail\":\"Missing credential 'alpaca_api_key'.\"}"))
    ).toBe("unkeyed");
  });

  it("anything else is unknown, never unkeyed", () => {
    expect(classifyProbeError(new Error("HTTP 401 from x: Not authenticated"))).toBe("unknown");
    expect(classifyProbeError(new Error("timeout"))).toBe("unknown");
    expect(classifyProbeError("weird non-error")).toBe("unknown");
  });
});

describe("defaultParamValues", () => {
  it("collects params that carry a default value", () => {
    const w = widget({
      params: [
        { paramName: "symbol", label: "Symbol", type: "text", value: "SPY" },
        { paramName: "interval", label: "Interval", type: "text", value: "1d" },
        { paramName: "start", label: "Start", type: "date", value: null },
      ] as WidgetDef["params"],
    });
    expect(defaultParamValues(w)).toEqual({ symbol: "SPY", interval: "1d" });
  });
});

describe("pickProbeWidget", () => {
  it("prefers the widget with the fewest defaultless params", () => {
    const needy = widget({
      id: "needy",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: null }] as WidgetDef["params"],
    });
    const ready = widget({
      id: "ready",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: "SPY" }] as WidgetDef["params"],
    });
    expect(pickProbeWidget([needy, ready], "eodhd")?.id).toBe("ready");
  });

  it("skips iframe and live_grid widgets", () => {
    const frame = widget({ id: "f", source: ["Eodhd"], type: "iframe" });
    expect(pickProbeWidget([frame], "eodhd")).toBeNull();
  });

  it("matches the provider by normalized name", () => {
    const w = widget({ id: "w1", source: ["Eodhd"] });
    expect(pickProbeWidget([w], "eodhd")?.id).toBe("w1");
    expect(pickProbeWidget([w], "fmp")).toBeNull();
  });

  it("only considers table and chart widgets: html/markdown/pdf/multi_file_viewer bodies aren't JSON, so res.json() would throw", () => {
    // Real fixture case: IMF's only widget is an html "presentation table".
    const htmlWidget = widget({ id: "h", source: ["Imf"], type: "html" });
    expect(pickProbeWidget([htmlWidget], "imf")).toBeNull();
    const markdownWidget = widget({ id: "m", source: ["Imf"], type: "markdown" });
    expect(pickProbeWidget([markdownWidget], "imf")).toBeNull();
    const pdfWidget = widget({ id: "p", source: ["Imf"], type: "pdf" });
    expect(pickProbeWidget([pdfWidget], "imf")).toBeNull();
    const multiFileWidget = widget({ id: "mf", source: ["Imf"], type: "multi_file_viewer" });
    expect(pickProbeWidget([multiFileWidget], "imf")).toBeNull();
  });

  it("accepts chart widgets, not just table, as probe candidates", () => {
    const chartWidget = widget({ id: "c", source: ["Eodhd"], type: "chart" });
    expect(pickProbeWidget([chartWidget], "eodhd")?.id).toBe("c");
  });

  it("accepts metric widgets as probe candidates: they return JSON like table/chart", () => {
    const metricWidget = widget({ id: "m", source: ["Eodhd"], type: "metric" });
    expect(pickProbeWidget([metricWidget], "eodhd")?.id).toBe("m");
  });

  it("returns null rather than firing a probe known to fail validation, when every candidate still has an unset param", () => {
    const needy = widget({
      id: "needy",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: null }] as WidgetDef["params"],
    });
    expect(pickProbeWidget([needy], "eodhd")).toBeNull();
  });
});

describe("widgetProviders", () => {
  it("returns distinct display names sorted", () => {
    const ws = [
      widget({ source: ["Eodhd"] }),
      widget({ source: ["Alpaca"] }),
      widget({ source: ["Eodhd"] }),
      widget({ source: [] }),
    ];
    expect(widgetProviders(ws)).toEqual(["Alpaca", "Eodhd"]);
  });
});

describe("badgeFor", () => {
  const status = (map: Record<string, ProviderKeyStatus>) => (name: string) =>
    map[name] ?? "unknown";

  it("returns null when the widget names no provider", () => {
    expect(badgeFor([], status({}))).toBeNull();
  });

  it("uses the provider's own name and status when there is exactly one", () => {
    expect(badgeFor(["Eodhd"], status({ Eodhd: "unkeyed" }))).toEqual({
      label: "Eodhd",
      status: "unkeyed",
      sources: ["Eodhd"],
    });
  });

  it("labels several providers Multisource", () => {
    expect(badgeFor(["Eodhd", "Fmp"], status({ Eodhd: "keyed", Fmp: "keyed" }))!.label).toBe(
      MULTISOURCE_LABEL
    );
  });

  it("is keyed when ANY provider is usable — the widget can be served", () => {
    // Matches how the library's filters already treat multi-source widgets,
    // so the badge and the filters cannot disagree.
    expect(badgeFor(["Eodhd", "Fmp"], status({ Eodhd: "unkeyed", Fmp: "keyed" }))!.status).toBe(
      "keyed"
    );
    expect(badgeFor(["Eodhd", "Fmp"], status({ Eodhd: "unknown", Fmp: "keyed" }))!.status).toBe(
      "keyed"
    );
  });

  it("is unkeyed only when EVERY provider is known to be missing its key", () => {
    expect(badgeFor(["Eodhd", "Fmp"], status({ Eodhd: "unkeyed", Fmp: "unkeyed" }))!.status).toBe(
      "unkeyed"
    );
  });

  it("is unknown when nothing is usable but something is unresolved", () => {
    // Never red on ambiguity: an unchecked provider might yet work.
    expect(badgeFor(["Eodhd", "Fmp"], status({ Eodhd: "unkeyed", Fmp: "unknown" }))!.status).toBe(
      "unknown"
    );
  });

  it("keeps every source name for the caller to show", () => {
    expect(badgeFor(["Eodhd", "Fmp"], status({}))!.sources).toEqual(["Eodhd", "Fmp"]);
  });
});
