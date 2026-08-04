import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BackendConfig, WidgetDef } from "./types";
import {
  HttpError, buildWidgetUrl, buildWidgetWsUrl, extractData, fetchWidgetData,
  fetchWidgetHtml, fetchWidgetsJson, serializeParams,
} from "./dataClient";
import { fetch as tauriHttpFetch } from "@tauri-apps/plugin-http";
import { startMockBackend, type MockBackend } from "../test/mockServer";
import { makeWidgetDef } from "../test/widgetDef";
import fixtures from "../test/fixtures/widgets.fixture.json";
import historical from "../test/fixtures/historical.fixture.json";
import { parseWidgetsJson } from "./widgets";

// Route plugin-http through Node's fetch so the mock server works in tests,
// but keep it a real spy so tests can prove requests actually flow through
// this module (regressing to globalThis.fetch directly would break CORS in
// the Tauri webview at runtime without failing any test here).
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
}));

const widgets = parseWidgetsJson(fixtures);
const tableWidget = widgets.find((w) => w.id === "equity_price_historical_eodhd_obb")!;
const chartWidget = widgets.find((w) => w.id === "equity_price_historical_eodhd_obb_chart")!;
const htmlWidget = widgets.find((w) => w.id === "imf_utils_presentation_table_custom_obb")!;
const iframeWidget = widgets.find((w) => w.id === "portfolio_iframe")!;

const backend: BackendConfig = {
  id: "nas", name: "OpenBB NAS", baseUrl: "https://openbb.example.test",
};

describe("serializeParams", () => {
  it("joins arrays with commas, stringifies booleans, drops empties", () => {
    expect(
      serializeParams({
        symbol: ["AAPL", "MSFT"], chart: true, raw: false,
        limit: 3, note: "", missing: null,
      })
    ).toEqual({ symbol: "AAPL,MSFT", chart: "true", raw: "false", limit: "3" });
  });
});

describe("buildWidgetUrl", () => {
  it("builds a GET url with query params", () => {
    const url = buildWidgetUrl(backend, tableWidget, {
      symbol: "AAPL", provider: "eodhd", start_date: "2026-07-01",
    });
    expect(url).toBe(
      "https://openbb.example.test/api/v1/equity/price/historical?symbol=AAPL&provider=eodhd&start_date=2026-07-01"
    );
  });

  it("adds theme to chart and html widgets only", () => {
    expect(buildWidgetUrl(backend, chartWidget, {}, { theme: "dark" })).toContain("theme=dark");
    expect(buildWidgetUrl(backend, htmlWidget, {}, { theme: "dark" })).toContain("theme=dark");
    expect(buildWidgetUrl(backend, tableWidget, {}, { theme: "dark" })).not.toContain("theme");
  });

  it("never themes iframe widgets and uses their endpoint verbatim", () => {
    const url = buildWidgetUrl(backend, iframeWidget, {}, { theme: "dark" });
    expect(url).toBe("http://localhost:8501/");
  });

  it("does not throw on a malformed iframe endpoint, returning it unchanged", () => {
    const missing: WidgetDef = { ...iframeWidget, endpoint: "" };
    const invalid: WidgetDef = { ...iframeWidget, endpoint: "not a url" };
    expect(() => buildWidgetUrl(backend, missing, {})).not.toThrow();
    expect(() => buildWidgetUrl(backend, invalid, {})).not.toThrow();
    expect(buildWidgetUrl(backend, missing, {})).toBe("");
    expect(buildWidgetUrl(backend, invalid, {})).toBe("not a url");
  });

  it("adds raw=true when the raw view is toggled", () => {
    expect(buildWidgetUrl(backend, htmlWidget, {}, { raw: true })).toContain("raw=true");
  });
});

describe("extractData", () => {
  it("passes arrays through untouched", () => {
    expect(extractData([1, 2], "results")).toEqual([1, 2]);
  });
  it("extracts a top-level dataKey", () => {
    expect(extractData(historical, "results")).toEqual(historical.results);
  });
  it("extracts a dotted dataKey path", () => {
    const resp = { chart: { content: { data: [], layout: {} } } };
    expect(extractData(resp, "chart.content")).toEqual({ data: [], layout: {} });
  });
  it("returns input unchanged when dataKey is null or path missing", () => {
    expect(extractData({ a: 1 }, null)).toEqual({ a: 1 });
    expect(extractData({ a: 1 }, "nope.deep")).toEqual({ a: 1 });
  });
});

describe("against the mock backend", () => {
  let mock: MockBackend;
  let mockBackendCfg: BackendConfig;
  beforeAll(async () => {
    mock = await startMockBackend();
    mockBackendCfg = {
      id: "mock", name: "Mock", baseUrl: mock.url,
      headerName: "X-API-KEY", headerValue: "secret123",
    };
  });
  afterAll(async () => { await mock.close(); });

  it("fetches and parses widgets.json", async () => {
    const defs = await fetchWidgetsJson(mockBackendCfg);
    expect(defs).toHaveLength(4);
  });

  it("fetches widget data, applies dataKey, sends the auth header", async () => {
    const data = await fetchWidgetData(mockBackendCfg, tableWidget, {
      symbol: ["AAPL", "MSFT"], provider: "eodhd",
    });
    expect(Array.isArray(data)).toBe(true);
    expect((data as unknown[]).length).toBe(3);
    const last = mock.requests[mock.requests.length - 1];
    expect(last.url).toContain("symbol=AAPL%2CMSFT");
    expect(last.headers["x-api-key"]).toBe("secret123");
    // Proves requests actually go through @tauri-apps/plugin-http's fetch,
    // not a direct globalThis.fetch call (that regression breaks CORS in
    // the Tauri webview at runtime without failing any test here).
    expect(vi.mocked(tauriHttpFetch)).toHaveBeenCalled();
  });

  it("throws HttpError with status and url on non-2xx", async () => {
    const boom: WidgetDef = { ...tableWidget, endpoint: "/boom", dataKey: null };
    await expect(fetchWidgetData(mockBackendCfg, boom, {})).rejects.toThrowError(HttpError);
    await expect(fetchWidgetData(mockBackendCfg, boom, {})).rejects.toMatchObject({ status: 500 });
  });

  it("raw view still resolves the widget's dataKey instead of the OBBject envelope", async () => {
    const data = await fetchWidgetData(mockBackendCfg, tableWidget, {
      symbol: "AAPL", provider: "eodhd",
    }, { raw: true });
    expect(data).toEqual(historical.results);
  });

  it("raw view falls back to the results array when no dataKey is configured", async () => {
    const noDataKey: WidgetDef = { ...tableWidget, dataKey: null };
    const data = await fetchWidgetData(mockBackendCfg, noDataKey, {
      symbol: "AAPL", provider: "eodhd",
    }, { raw: true });
    expect(data).toEqual(historical.results);
  });

  it("fetches widget html through fetchWidgetHtml, requesting the dark theme", async () => {
    const html = await fetchWidgetHtml(mockBackendCfg, htmlWidget, {});
    expect(html).toBe("<html><body><h1>IMF</h1><script>document.title='ok'</script></body></html>");
    const last = mock.requests[mock.requests.length - 1];
    expect(last.url).toContain("theme=dark");
  });
});

describe("buildWidgetUrl endpoint resolution", () => {
  const widget = (endpoint: string) =>
    ({ ...makeWidgetDef(), endpoint, type: "table" }) as WidgetDef;

  it("keeps the backend's base path", () => {
    // new URL("/widgets/x", "https://host/openbb/api") discards /openbb/api and
    // resolves to the host root, so every request missed the mount point.
    const backend = { id: "b", name: "b", baseUrl: "https://host/openbb/api" };
    expect(buildWidgetUrl(backend as any, widget("/widgets/prices"), {})).toBe(
      "https://host/openbb/api/widgets/prices"
    );
  });

  it("keeps the base path when it has a trailing slash", () => {
    const backend = { id: "b", name: "b", baseUrl: "https://host/openbb/" };
    expect(buildWidgetUrl(backend as any, widget("widgets/prices"), {})).toBe(
      "https://host/openbb/widgets/prices"
    );
  });

  it("cannot be retargeted at another origin by the endpoint", () => {
    // "//evil.example/x" is protocol-relative: new URL would resolve it to
    // https://evil.example/x, and the request would carry the backend's auth
    // header there. widgets.json is remote input, so this is reachable.
    const backend = { id: "b", name: "b", baseUrl: "https://host" };
    const url = new URL(buildWidgetUrl(backend as any, widget("//evil.example/x"), {}));
    expect(url.origin).toBe("https://host");
  });

  it("still appends params under a base path", () => {
    const backend = { id: "b", name: "b", baseUrl: "https://host/api" };
    const url = buildWidgetUrl(backend as any, widget("/prices"), { symbol: "AAPL" });
    expect(url).toBe("https://host/api/prices?symbol=AAPL");
  });
});

describe("out-of-scope URLs", () => {
  it("replaces plugin-http's refusal with something actionable", async () => {
    // The original names the URL and stops, which leaves the reader to work out
    // that the allowlist is compiled in, comes from .env.local, and needs a
    // rebuild — none of it guessable from the wording.
    const fetchImpl = vi.fn(async () => {
      throw new Error("url not allowed on the configured scope: https://nope.example.com/widgets.json");
    });
    const backend = { id: "b", name: "b", baseUrl: "https://nope.example.com" } as BackendConfig;

    await expect(fetchWidgetsJson(backend, fetchImpl as never)).rejects.toThrow(
      /not in this build's HTTP allowlist/
    );
    await expect(fetchWidgetsJson(backend, fetchImpl as never)).rejects.toThrow(/\.env\.local/);
  });

  it("leaves an ordinary network failure alone", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Connection refused");
    });
    const backend = { id: "b", name: "b", baseUrl: "https://down.example" } as BackendConfig;
    await expect(fetchWidgetsJson(backend, fetchImpl as never)).rejects.toThrow("Connection refused");
  });
});


describe("buildWidgetWsUrl (v8, live_grid)", () => {
  it("swaps https to wss and resolves under the backend's base path", () => {
    const w = makeWidgetDef({ type: "live_grid", wsEndpoint: "/live_grid_ws" });
    expect(buildWidgetWsUrl(backend, w)).toBe(
      "wss://openbb.example.test/live_grid_ws"
    );
    expect(
      buildWidgetWsUrl({ ...backend, baseUrl: "http://127.0.0.1:6903" }, w)
    ).toBe("ws://127.0.0.1:6903/live_grid_ws");
    expect(
      buildWidgetWsUrl({ ...backend, baseUrl: "https://host.example/openbb/api" }, w)
    ).toBe("wss://host.example/openbb/api/live_grid_ws");
  });

  it("returns null without a wsEndpoint", () => {
    expect(buildWidgetWsUrl(backend, makeWidgetDef({ type: "live_grid" }))).toBeNull();
    expect(
      buildWidgetWsUrl(backend, makeWidgetDef({ type: "live_grid", wsEndpoint: null }))
    ).toBeNull();
  });

  it("cannot be steered off-origin by a protocol-relative wsEndpoint", () => {
    // widgets.json is remote input; "//evil.example/x" must stay a path under
    // the backend origin, same as buildWidgetUrl.
    const w = makeWidgetDef({ type: "live_grid", wsEndpoint: "//evil.example/x" });
    const url = buildWidgetWsUrl(backend, w)!;
    expect(new URL(url.replace(/^ws/, "http")).host).toBe("openbb.example.test");
  });
});
