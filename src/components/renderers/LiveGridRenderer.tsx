import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BackendConfig, ColumnDef, ParamValues, WidgetDef,
} from "../../lib/types";
import { buildWidgetWsUrl, serializeParams } from "../../lib/dataClient";
import { formatCell, orderColumns } from "./TableRenderer";
import RawJsonView from "./RawJsonView";
import { logError, logOnce } from "../../lib/logger";

/**
 * live_grid: a table whose rows update in place over a websocket.
 *
 * The card's normal GET fetch supplies the seed rows (`data`); this renderer
 * then opens the widget's wsEndpoint, sends `{"params": {...}}` on connect and
 * on every parameter change (the live_grid protocol — the backend adjusts its
 * upstream subscriptions to match), and merges each streamed row into the grid
 * by the wsRowIdColumn value.
 *
 * Updated cells flash. The flash is retriggered by remounting the cell's inner
 * span (its React key carries an update counter), so there are no timers to
 * leak; a column with enableCellChangeWs: false (volume — it changes on every
 * tick) never flashes.
 */

/** Delay before re-dialing a dropped socket. Short enough that a backend
 * restart is a blip, long enough not to hammer a down host. */
const RETRY_MS = 3000;

interface LiveGridRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  /** The card's backend; undefined when unconfigured (no socket is opened). */
  backend: BackendConfig | undefined;
  /** Effective (group-resolved) param values — the same ones the seed GET used. */
  params: ParamValues;
  theme: "dark";
}

type Row = Record<string, unknown>;

interface Flash {
  /** Bumped per update so the span remounts and the animation restarts. */
  seq: number;
  dir: "up" | "down" | "same";
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** greenRed colors by the cell's own sign; showCellChange by the sign of
 * renderFnParams.colorValueKey's value in the same row. */
function cellColorClass(col: ColumnDef, row: Row): string {
  let basis: unknown;
  if (col.renderFn === "greenRed") {
    basis = row[col.field];
  } else if (col.renderFn === "showCellChange") {
    const key = col.renderFnParams?.colorValueKey;
    if (!key) return "";
    basis = row[key];
  } else {
    return "";
  }
  const n = toNum(basis);
  if (n === null || n === 0) return "";
  return n > 0 ? "cell-pos" : "cell-neg";
}

export default function LiveGridRenderer({
  data, widgetDef, backend, params, theme,
}: LiveGridRendererProps) {
  const idCol = widgetDef.wsRowIdColumn ?? null;
  const [rows, setRows] = useState<Row[]>([]);
  const [flashes, setFlashes] = useState<Record<string, Flash>>({});
  const [live, setLive] = useState(false);
  // Mirror of `rows` for the message handler: ws frames arrive outside the
  // render cycle, and computing the merge from a ref keeps the setState
  // updaters pure (no setFlashes from inside setRows).
  const rowsRef = useRef<Row[]>([]);

  // Columns that must not flash, per widgets.json.
  const noFlash = useMemo(() => {
    const out = new Set<string>();
    for (const c of widgetDef.columnsDefs ?? []) {
      if (c.enableCellChangeWs === false) out.add(c.field);
    }
    return out;
  }, [widgetDef.columnsDefs]);

  // Seed (and re-seed after a refresh or param change): the GET response
  // replaces the grid; streamed updates then merge into it.
  useEffect(() => {
    if (Array.isArray(data)) {
      const seeded = data.filter((r): r is Row => r !== null && typeof r === "object");
      rowsRef.current = seeded;
      setRows(seeded);
      setFlashes({});
    }
  }, [data]);

  const applyUpdate = useCallback(
    (raw: unknown) => {
      if (!idCol) return;
      let msg: unknown = raw;
      if (typeof raw === "string") {
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
      }
      const updates = (Array.isArray(msg) ? msg : [msg]).filter(
        (u): u is Row => u !== null && typeof u === "object"
      );
      if (updates.length === 0) return;
      const next = [...rowsRef.current];
      const changed: Record<string, Flash["dir"]> = {};
      for (const u of updates) {
        const id = u[idCol];
        if (id === null || id === undefined) continue;
        const key = String(id);
        const i = next.findIndex((r) => String(r[idCol]) === key);
        if (i === -1) {
          // A symbol the seed never saw (added via a param change while the
          // GET was failing, or streamed ahead of it): show it rather than
          // dropping ticks on the floor.
          next.push(u);
          continue;
        }
        const old = next[i];
        const merged = { ...old, ...u };
        next[i] = merged;
        for (const field of Object.keys(u)) {
          if (field === idCol || noFlash.has(field)) continue;
          if (Object.is(old[field], merged[field])) continue;
          const was = toNum(old[field]);
          const now = toNum(merged[field]);
          changed[`${key}|${field}`] =
            was !== null && now !== null && was !== now
              ? now > was
                ? "up"
                : "down"
              : "same";
        }
      }
      rowsRef.current = next;
      setRows(next);
      if (Object.keys(changed).length > 0) {
        setFlashes((f) => {
          const out = { ...f };
          for (const [fkey, dir] of Object.entries(changed)) {
            out[fkey] = { dir, seq: (f[fkey]?.seq ?? 0) + 1 };
          }
          return out;
        });
      }
    },
    [idCol, noFlash]
  );

  const wsUrl = useMemo(
    () => (backend ? buildWidgetWsUrl(backend, widgetDef) : null),
    [backend, widgetDef]
  );

  // The subscription message: the live_grid protocol sends the widget's
  // params, serialized the same way the GET query string is.
  const paramsJson = useMemo(
    () => JSON.stringify({ params: serializeParams(params) }),
    [params]
  );

  const wsRef = useRef<WebSocket | null>(null);
  const paramsRef = useRef(paramsJson);

  // Param change with the socket already open: re-send rather than re-dial.
  useEffect(() => {
    paramsRef.current = paramsJson;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(paramsJson);
  }, [paramsJson]);

  const applyRef = useRef(applyUpdate);
  useEffect(() => {
    applyRef.current = applyUpdate;
  }, [applyUpdate]);

  useEffect(() => {
    if (!wsUrl) {
      if (widgetDef.wsEndpoint) {
        logOnce(
          `live-grid-nows-${widgetDef.id}`,
          `live_grid ${widgetDef.id}: no usable websocket URL; showing seed only`
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
        logError(`live_grid ${widgetDef.id}: websocket open failed: ${String(e)}`);
        return;
      }
      wsRef.current = sock;
      sock.onopen = () => {
        setLive(true);
        sock.send(paramsRef.current);
      };
      sock.onmessage = (ev: MessageEvent) => applyRef.current(ev.data);
      // onerror is always followed by onclose; the close handler owns retry.
      sock.onclose = () => {
        setLive(false);
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

  if (data === null || data === undefined) {
    return <div className="renderer-empty">No data available</div>;
  }
  if (!Array.isArray(data)) {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  const declared = (widgetDef.columnsDefs ?? []).filter(
    (c) => c != null && typeof (c as { field?: unknown }).field === "string"
  );
  const cols: ColumnDef[] = declared.length
    ? orderColumns(declared)
    : Object.keys(rows[0] ?? {}).map((field) => ({ field, headerName: field }));

  if (rows.length === 0) {
    return <div className="renderer-empty">No data available</div>;
  }

  return (
    <div className={`table-container live-grid ${theme}`}>
      <div className="live-grid-status">
        <span
          className={`live-dot ${live ? "on" : "off"}`}
          title={live ? "Streaming" : "Reconnecting…"}
          aria-hidden="true"
        />
        <span className="live-grid-status-label">
          {live ? "live" : "reconnecting…"}
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.field} title={c.headerTooltip}>
                {c.headerName || c.field}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const rowKey = idCol ? String(row[idCol]) : String(ri);
            return (
              <tr key={rowKey}>
                {cols.map((c) => {
                  const flash = flashes[`${rowKey}|${c.field}`];
                  const color = cellColorClass(c, row);
                  return (
                    <td key={c.field} className={color || undefined}>
                      <span
                        // Remounting on seq restarts the CSS animation.
                        key={flash?.seq ?? 0}
                        className={
                          flash && flash.seq > 0
                            ? `cell-flash flash-${flash.dir}`
                            : undefined
                        }
                      >
                        {formatCell(row[c.field], c)}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
