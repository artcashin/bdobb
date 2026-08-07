import { useEffect, useMemo, useRef, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, ParamValues, WidgetDef } from "../../lib/types";
import { fetchJson, resolveEndpoint, serializeParams } from "../../lib/dataClient";
import {
  applyTick, seedToBar, BUCKET_MS,
  type Bar, type SeedBar,
} from "../../lib/liveChartBucketing";
import { buildSingleFigure, buildOverlayFigure, type ChartType } from "../../lib/liveChartFigure";
import LiveChartPanel from "./LiveChartPanel";
import { logError, logOnce } from "../../lib/logger";

const RETRY_MS = 3000;
const DEFAULT_INTERVAL = "1m";

interface LiveChartRendererProps {
  widgetDef: WidgetDef;
  backend: BackendConfig | undefined;
  params: ParamValues;
  theme: "dark";
  fetchImpl?: typeof fetch;
}

interface SymbolState {
  bars: Bar[];
  loading: boolean;
  error: string | null;
}

function parseSymbols(value: ParamValues[string]): string[] {
  const s = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return s.split(",").map((sym) => sym.trim()).filter(Boolean);
}

function isSeedBarArray(x: unknown): x is SeedBar[] {
  return Array.isArray(x) && x.every((r) => r !== null && typeof r === "object" && "date" in r);
}

const CHART_TYPES: ChartType[] = ["line", "area", "candle"];

/**
 * live_chart: seeds per-symbol history from /series (one call per symbol --
 * unlike live_grid's seed endpoint, /series takes exactly one symbol), then
 * buckets the shared live_grid_ws tick stream into bars itself. Bypasses
 * WidgetCard's generic seed fetch entirely (see WidgetCard.tsx's live_chart
 * special case) because that fetch would comma-join a multi-symbol query
 * against an endpoint that only accepts one.
 */
export default function LiveChartRenderer({
  widgetDef, backend, params, theme, fetchImpl = tauriFetch,
}: LiveChartRendererProps) {
  const symbols = useMemo(() => parseSymbols(params.symbol), [params.symbol]);
  const interval = useMemo(() => String(params.interval ?? DEFAULT_INTERVAL), [params.interval]);
  const bucketMs = BUCKET_MS[interval] ?? BUCKET_MS[DEFAULT_INTERVAL];

  const [chartType, setChartType] = useState<ChartType>("line");
  const [bySymbol, setBySymbol] = useState<Record<string, SymbolState>>({});

  // Seed: one /series call per symbol, whenever the symbol list, interval,
  // or backend changes. A symbol whose call fails renders in its own error
  // state without affecting the others.
  useEffect(() => {
    if (!backend) return;
    let cancelled = false;
    setBySymbol(
      Object.fromEntries(symbols.map((s) => [s, { bars: [], loading: true, error: null }]))
    );
    for (const symbol of symbols) {
      const url = resolveEndpoint(backend.baseUrl, widgetDef.endpoint);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      fetchJson(url.toString(), backend, fetchImpl)
        .then((json) => {
          if (cancelled) return;
          const raw = (json as { bars?: unknown } | null)?.bars;
          const bars = isSeedBarArray(raw) ? raw.map(seedToBar) : [];
          setBySymbol((s) => ({ ...s, [symbol]: { bars, loading: false, error: null } }));
        })
        .catch((e) => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          logError(`live_chart ${widgetDef.id}: seed failed for ${symbol}: ${msg}`);
          setBySymbol((s) => ({ ...s, [symbol]: { bars: [], loading: false, error: msg } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [backend, widgetDef.endpoint, symbols, interval, fetchImpl, widgetDef.id]);

  // Live: one websocket, shared across every subscribed symbol -- same
  // protocol LiveGridRenderer uses. Each tick is routed by its own `symbol`
  // field and bucketed into that symbol's series.
  const wsUrl = useMemo(() => {
    if (!backend || !widgetDef.wsEndpoint) return null;
    const url = resolveEndpoint(backend.baseUrl, widgetDef.wsEndpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/^http/, "ws");
  }, [backend, widgetDef.wsEndpoint]);

  const subscribeMsg = useMemo(
    () => JSON.stringify({ params: serializeParams({ symbol: symbols.join(",") }) }),
    [symbols]
  );
  const subscribeRef = useRef(subscribeMsg);
  const bucketMsRef = useRef(bucketMs);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    subscribeRef.current = subscribeMsg;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(subscribeMsg);
  }, [subscribeMsg]);

  // Keep the onmessage handler's bucketing interval current without forcing
  // the websocket-connect effect below to re-run (and tear down/reopen the
  // live socket) on an interval-only change -- same ref pattern as
  // subscribeRef above.
  useEffect(() => {
    bucketMsRef.current = bucketMs;
  }, [bucketMs]);

  useEffect(() => {
    if (!wsUrl) {
      if (widgetDef.wsEndpoint) {
        logOnce(
          `live-chart-nows-${widgetDef.id}`,
          `live_chart ${widgetDef.id}: no usable websocket URL; showing seed only`
        );
      }
      return;
    }
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed) return;
      let sock: WebSocket;
      try {
        sock = new WebSocket(wsUrl);
      } catch (e) {
        logError(`live_chart ${widgetDef.id}: websocket open failed: ${String(e)}`);
        return;
      }
      wsRef.current = sock;
      sock.onopen = () => sock.send(subscribeRef.current);
      sock.onmessage = (ev: MessageEvent) => {
        let msg: unknown;
        try {
          msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
        } catch {
          return;
        }
        const ticks = (Array.isArray(msg) ? msg : [msg]).filter(
          (t): t is { symbol: string } & Record<string, unknown> =>
            t !== null && typeof t === "object" && typeof (t as { symbol?: unknown }).symbol === "string"
        );
        if (ticks.length === 0) return;
        const now = Date.now();
        setBySymbol((s) => {
          let changed = false;
          const next = { ...s };
          for (const tick of ticks) {
            const cur = next[tick.symbol];
            if (!cur) continue; // not a symbol this card is displaying
            const bars = applyTick(cur.bars, tick, bucketMsRef.current, now);
            if (bars !== cur.bars) {
              next[tick.symbol] = { ...cur, bars };
              changed = true;
            }
          }
          return changed ? next : s;
        });
      };
      sock.onclose = () => {
        if (wsRef.current === sock) wsRef.current = null;
        if (!disposed) retry = setTimeout(connect, RETRY_MS);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      const sock = wsRef.current;
      wsRef.current = null;
      sock?.close();
    };
  }, [wsUrl, widgetDef.id, widgetDef.wsEndpoint]);

  if (symbols.length === 0) {
    return <div className="renderer-empty">No symbol selected</div>;
  }

  const single = symbols.length === 1;
  const smallMultiples = !single && chartType === "candle";

  const renderBody = () => {
    if (single) {
      const state = bySymbol[symbols[0]];
      if (!state || state.loading) return <div className="renderer-empty">Loading…</div>;
      if (state.error) return <div className="error">{state.error}</div>;
      return <LiveChartPanel figure={buildSingleFigure(state.bars, chartType)} />;
    }
    if (smallMultiples) {
      return (
        <div className="live-chart-small-multiples">
          {symbols.map((symbol) => {
            const state = bySymbol[symbol];
            if (!state || state.loading) {
              return <div key={symbol} className="renderer-empty">Loading {symbol}…</div>;
            }
            if (state.error) {
              return <div key={symbol} className="error">{symbol}: {state.error}</div>;
            }
            return (
              <LiveChartPanel key={symbol} title={symbol} figure={buildSingleFigure(state.bars, "candle")} />
            );
          })}
        </div>
      );
    }
    const ready = Object.fromEntries(
      symbols
        .filter((s) => bySymbol[s] && !bySymbol[s].loading && !bySymbol[s].error)
        .map((s) => [s, bySymbol[s].bars])
    );
    if (Object.keys(ready).length === 0) return <div className="renderer-empty">Loading…</div>;
    return <LiveChartPanel figure={buildOverlayFigure(ready, chartType === "area" ? "area" : "line")} />;
  };

  return (
    <div className={`live-chart-container ${theme}`}>
      <div className="live-chart-controls">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={`live-chart-type-btn${chartType === t ? " active" : ""}`}
            onClick={() => setChartType(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {renderBody()}
    </div>
  );
}
