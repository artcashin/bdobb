import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef as TanstackColumnDef,
} from "@tanstack/react-table";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, WidgetDef } from "../../lib/types";
import { fetchJson, fetchWidgetData, resolveEndpoint } from "../../lib/dataClient";
import { logError } from "../../lib/logger";

/** One row of the /keys envelope. `value` (tier 3) is deliberately not part
 * of this type's read surface — see the secrecy note on KeysRow below. */
interface KeysTestResult {
  result: string;
  detail: string;
}

interface KeysRow {
  provider: string;
  env_var: string;
  status: "set" | "empty" | "missing" | "unknown";
  demo: boolean;
  test?: KeysTestResult;
  // Tier 3 rows may carry `value` (the raw secret). It is never read here —
  // this renderer must not put a key value in the DOM under any tier.
}

interface KeysEnvelope {
  tier: number;
  rows: KeysRow[];
}

function isKeysEnvelope(data: unknown): data is KeysEnvelope {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as { rows?: unknown }).rows)
  );
}

/** Dot colour + accessible label per `test.result`. Absent or "skipped"
 * both mean "no probe has run" and are neutral. */
const DOT_BY_RESULT: Record<string, { cls: string; label: string }> = {
  ok: { cls: "ok", label: "Reachable" },
  error: { cls: "warn", label: "Vendor returned an error" },
  auth_failed: { cls: "warn", label: "Key rejected by vendor" },
  no_response: { cls: "down", label: "Not responding" },
  skipped: { cls: "idle", label: "Not tested" },
};
const IDLE_DOT = { cls: "idle", label: "Not tested" };

function dotFor(row: KeysRow): { cls: string; label: string } {
  const result = row.test?.result;
  if (!result) return IDLE_DOT;
  return DOT_BY_RESULT[result] ?? IDLE_DOT;
}

/** Pill colour + text per key state. Text always states the state in words
 * so colour is never the only carrier of meaning. */
function pillFor(row: KeysRow): { cls: string; text: string } {
  if (row.status === "set") {
    return row.demo ? { cls: "demo", text: "Demo key" } : { cls: "own", text: "Own key" };
  }
  if (row.status === "empty" || row.status === "missing") {
    return { cls: "unset", text: "Not set" };
  }
  return { cls: "unknown", text: "Unknown" };
}

/** Extracts a validated {result, detail} pair from an untrusted response
 * body, or null if it doesn't look like one. */
function asTestResult(json: unknown): KeysTestResult | null {
  if (json === null || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  if (typeof r.result !== "string") return null;
  return { result: r.result, detail: typeof r.detail === "string" ? r.detail : "" };
}

interface KeysRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
  /** The card's own backend. Requests for both the all-providers sweep and
   * the per-row test carry this backend's auth header (WidgetCard resolves
   * it the same way it already does for LiveGridRenderer). Undefined only
   * when the card's backend is unconfigured — WidgetCard shows its own error
   * before this renderer ever mounts in that case, so probing is simply
   * skipped rather than guarded with a user-facing message here. */
  backend?: BackendConfig;
  /** Test seam; defaults to the Tauri HTTP plugin (CORS-free, scoped). */
  fetchImpl?: typeof fetch;
}

interface MenuState {
  envVar: string;
  provider: string;
  x: number;
  y: number;
}

/**
 * Accessible right-click menu for a single row. Escape closes it, a click
 * outside dismisses it, arrow keys move (and wrap) between items, and the
 * first item takes focus the moment it opens so a keyboard user who summoned
 * it via the ContextMenu key lands somewhere useful.
 */
function KeysContextMenu({
  provider,
  onTest,
  onClose,
}: {
  provider: string;
  onTest: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  const items = useMemo(() => [{ label: "Test this service", onSelect: onTest }], [onTest]);

  useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  const moveFocus = useCallback((delta: number) => {
    const count = itemRefs.current.length;
    if (count === 0) return;
    const current = itemRefs.current.findIndex((el) => el === document.activeElement);
    const next = ((current === -1 ? 0 : current) + delta + count) % count;
    itemRefs.current[next]?.focus();
  }, []);

  return (
    <ul
      ref={menuRef}
      role="menu"
      aria-label={`Actions for ${provider}`}
      className="keys-context-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(-1);
        }
      }}
    >
      {items.map((item, i) => (
        <li
          key={item.label}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          role="menuitem"
          tabIndex={-1}
          onClick={item.onSelect}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              item.onSelect();
            }
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// widgetDef is used to resolve probe endpoints (its own endpoint plus a
// query param for the sweep, its endpoint plus /{env_var}/test for a single
// row) — kept interchangeable with the other renderers WidgetCard dispatches
// to otherwise.
export default function KeysRenderer({
  data,
  widgetDef,
  theme,
  backend,
  fetchImpl = tauriFetch,
}: KeysRendererProps) {
  const baseRows = useMemo<KeysRow[]>(
    () => (isKeysEnvelope(data) ? data.rows : []),
    [data]
  );

  // Per-provider probe results, keyed by env_var. Populated wholesale by the
  // mount sweep and by Refresh, patched one entry at a time by a row's "Test
  // this service" — kept apart from baseRows so a plain re-render (a new
  // `data` prop from WidgetCard's own unrelated refetch) never discards a
  // result already in hand, and a single-row test never touches the other
  // 17 providers' dots.
  const [testResults, setTestResults] = useState<Record<string, KeysTestResult>>({});
  const [probing, setProbing] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const rows = useMemo<KeysRow[]>(
    () =>
      baseRows.map((r) =>
        testResults[r.env_var] ? { ...r, test: testResults[r.env_var] } : r
      ),
    [baseRows, testResults]
  );

  // True for the lifetime of the mounted component; guards state updates
  // that land after an in-flight probe's owner has already unmounted.
  const isMountedRef = useRef(true);
  useEffect(
    () => () => {
      isMountedRef.current = false;
    },
    []
  );

  const probeAll = useCallback(async () => {
    if (!backend) return;
    setProbing(true);
    try {
      const json = await fetchWidgetData(backend, widgetDef, { run_tests: true }, {}, fetchImpl);
      if (!isMountedRef.current || !isKeysEnvelope(json)) return;
      const next: Record<string, KeysTestResult> = {};
      for (const row of json.rows) {
        if (row && typeof row === "object" && typeof row.env_var === "string" && row.test) {
          next[row.env_var] = row.test;
        }
      }
      setTestResults(next);
    } catch (e) {
      logError(`keys widget probe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (isMountedRef.current) setProbing(false);
    }
  }, [backend, widgetDef, fetchImpl]);

  // Probe once on mount, never again from a re-render. hasProbedRef — not
  // the effect's dependency array — is the probe-once contract: it is set
  // synchronously inside the effect body before the fetch even starts, and
  // it survives React StrictMode's dev-only mount -> cleanup -> mount replay
  // of effects, which reuses this same component instance (state and refs
  // are not reset by that replay, only the effect functions are re-run). A
  // dashboard opening a keys card must fire the ~18 vendor calls exactly
  // once, not once per StrictMode replay and not again on every unrelated
  // parent re-render.
  const hasProbedRef = useRef(false);
  useEffect(() => {
    if (!backend || hasProbedRef.current) return;
    hasProbedRef.current = true;
    probeAll();
    // Intentionally only [backend]: this must run once per mount, not once
    // per identity change of probeAll (which is rebuilt if widgetDef or
    // fetchImpl change reference). The ref guard above is what enforces
    // "once," not this dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  const testOne = useCallback(
    async (envVar: string) => {
      if (!backend) return;
      try {
        const url = resolveEndpoint(
          backend.baseUrl,
          `${widgetDef.endpoint}/${encodeURIComponent(envVar)}/test`
        ).toString();
        const json = await fetchJson(url, backend, fetchImpl);
        const result = asTestResult(json);
        if (!isMountedRef.current || !result) return;
        setTestResults((prev) => ({ ...prev, [envVar]: result }));
      } catch (e) {
        logError(`keys widget test failed for ${envVar}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [backend, widgetDef.endpoint, fetchImpl]
  );

  const openMenu = useCallback((row: KeysRow, x: number, y: number) => {
    setMenu({ envVar: row.env_var, provider: row.provider, x, y });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const columns = useMemo<TanstackColumnDef<KeysRow>[]>(
    () => [
      {
        id: "dot",
        // Visually blank — the column reads as an icon rail — but still
        // named for screen readers, which otherwise get an unlabeled header.
        header: () => <span className="sr-only">Reachability</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const { cls, label } = dotFor(row.original);
          return <span className={`keys-dot ${cls}`} aria-label={label} title={label} />;
        },
      },
      {
        id: "provider",
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => <span className="keys-provider">{row.original.provider}</span>,
      },
      {
        id: "pill",
        header: "Key",
        enableSorting: false,
        cell: ({ row }) => {
          const { cls, text } = pillFor(row.original);
          return <span className={`keys-pill ${cls}`}>{text}</span>;
        },
      },
      {
        id: "detail",
        header: "Detail",
        enableSorting: false,
        cell: ({ row }) => <span>{row.original.test?.detail ?? ""}</span>,
      },
    ],
    []
  );

  const table = useReactTable({
    data: rows,
    columns,
    // Mirrors TableRenderer: onChange so a drag updates the width live, and
    // sorting registered so the provider header can toggle it.
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (rows.length === 0) {
    return <div className="renderer-empty">No data available</div>;
  }

  return (
    <div className={`table-container ${theme}`}>
      {backend && (
        <div className="keys-toolbar">
          <button
            type="button"
            className="keys-refresh"
            onClick={probeAll}
            disabled={probing}
          >
            {probing ? "Testing…" : "Refresh"}
          </button>
        </div>
      )}
      <table className="table">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const sortable = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    className={sortable ? "sortable" : undefined}
                    style={{ width: header.getSize() }}
                    tabIndex={sortable ? 0 : undefined}
                    onClick={sortable ? header.column.getToggleSortingHandler() : undefined}
                    onKeyDown={(e) => {
                      if (!sortable || e.repeat) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        header.column.getToggleSortingHandler()?.(e);
                      }
                    }}
                    aria-sort={
                      sortable
                        ? sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                  >
                    <span className="th-label">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </span>
                    <span aria-hidden="true">
                      {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
                    </span>
                    {header.column.getCanResize() && (
                      <span
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${String(header.column.id)}`}
                        className={`col-resizer ${header.column.getIsResizing() ? "resizing" : ""}`}
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const original = row.original;
            return (
              <tr
                key={row.id}
                tabIndex={backend ? 0 : undefined}
                onContextMenu={
                  backend
                    ? (e) => {
                        e.preventDefault();
                        openMenu(original, e.clientX, e.clientY);
                      }
                    : undefined
                }
                onKeyDown={
                  backend
                    ? (e) => {
                        // The cross-browser "open context menu" keys: the
                        // dedicated ContextMenu key, and Shift+F10 where it
                        // doesn't exist. Right-click alone would leave this
                        // menu unreachable without a mouse.
                        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                          e.preventDefault();
                          const rect = e.currentTarget.getBoundingClientRect();
                          openMenu(original, rect.left, rect.bottom);
                        }
                      }
                    : undefined
                }
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {menu && (
        <div
          className="keys-context-menu-anchor"
          style={{ position: "fixed", top: menu.y, left: menu.x }}
        >
          <KeysContextMenu
            provider={menu.provider}
            onTest={() => {
              const envVar = menu.envVar;
              closeMenu();
              void testOne(envVar);
            }}
            onClose={closeMenu}
          />
        </div>
      )}
    </div>
  );
}
