import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef as TanstackColumnDef,
} from "@tanstack/react-table";
import type { WidgetDef } from "../../lib/types";

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
 * both mean "no probe has run" and are neutral — probing lands in a later
 * task, so most rows arrive in this state today. */
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

interface KeysRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

// widgetDef is accepted (not used) to keep this renderer's signature
// interchangeable with the other renderers WidgetCard dispatches to.
export default function KeysRenderer({ data, theme }: KeysRendererProps) {
  const rows = useMemo<KeysRow[]>(
    () => (isKeysEnvelope(data) ? data.rows : []),
    [data]
  );

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
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
