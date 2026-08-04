import { useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type ColumnDef as TanstackColumnDef,
} from "@tanstack/react-table";
import type { ColumnDef, WidgetDef } from "../../lib/types";
import RawJsonView from "./RawJsonView";

// Never render the literal string "NaN", and never fabricate a "0" for a
// value that isn't actually numeric.
const MISSING_NUMBER = "—";

/** Finite number, or a non-empty string that parses to one — anything else
 * (NaN, "", [], booleans, objects) is not numeric. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

/** The calendar date embedded in the string is always what should be shown —
 * whether it carries a UTC offset, a "Z", or no time at all. Converting
 * through `Date`/`toISOString` re-bases to UTC and can shift the date a day
 * in either direction, so a leading YYYY-MM-DD is taken verbatim instead.
 * Only a genuinely different format falls through to local date-part
 * formatting. */
function formatDateCell(value: unknown): string {
  const s = String(value);
  if (DATE_PREFIX_RE.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Type-aware cell formatting, per the spec's dates/percentages/large numbers. */
export function formatCell(value: unknown, col: ColumnDef): string {
  if (value === null || value === undefined) return "";
  const fn = col.formatterFn ?? null;
  // "percent" has historically been set on `cellDataType` (outside its typed
  // union) by some widgets.json entries as well as via the typed
  // `formatterFn`; honor both so neither convention silently stops working.
  const cellType = col.cellDataType as string | undefined;
  let out: string;
  if (fn === "int") {
    const n = toFiniteNumber(value);
    if (n === null) return MISSING_NUMBER;
    out = Math.round(n).toLocaleString();
  } else if (fn === "percent" || cellType === "percent") {
    const n = toFiniteNumber(value);
    if (n === null) return MISSING_NUMBER;
    out = `${(n * 100).toFixed(col.decimalPlaces ?? 2)}%`;
  } else if (fn === "none") {
    out = String(value);
  } else if (cellType === "date" || cellType === "dateString") {
    out = formatDateCell(value);
  } else if (cellType === "number" || typeof value === "number") {
    const n = toFiniteNumber(value);
    if (n === null) return MISSING_NUMBER;
    out = n.toLocaleString(undefined, {
      minimumFractionDigits: col.decimalPlaces ?? (Number.isInteger(n) ? 0 : 2),
      maximumFractionDigits: col.decimalPlaces ?? (Number.isInteger(n) ? 0 : 2),
    });
  } else if (typeof value === "object") {
    out = JSON.stringify(value);
  } else {
    out = String(value);
  }
  // other formatterFns (normalized, normalizedPercent, dateToYear) are
  // intentionally ignored in v1 and fall through to the branches above
  return `${col.prefix ?? ""}${out}${col.suffix ?? ""}`;
}

/** Hidden columns are dropped and pinned columns are grouped to their edge,
 * honoring the full ColumnDef contract instead of only reading `field`. */
export function orderColumns(cols: ColumnDef[]): ColumnDef[] {
  const visible = cols.filter((c) => !c.hide);
  return [
    ...visible.filter((c) => c.pinned === "left"),
    ...visible.filter((c) => !c.pinned),
    ...visible.filter((c) => c.pinned === "right"),
  ];
}

interface TableRendererProps {
  data: unknown;
  widgetDef: WidgetDef;
  theme: "dark";
}

export default function TableRenderer({ data, widgetDef, theme }: TableRendererProps) {
  const tableData = useMemo<Record<string, unknown>[]>(
    () => (Array.isArray(data) ? data : []),
    [data]
  );

  const columns = useMemo(() => {
    // Fall back to the keys of the first row: a widgets.json entry without
    // columnsDefs previously produced a table with zero columns, which renders
    // as a blank card even though there is data to show.
    const declared = (widgetDef.columnsDefs ?? []).filter(
      (c) => c != null && typeof (c as { field?: unknown }).field === "string"
    );
    const defs: ColumnDef[] = declared.length
      ? orderColumns(declared)
      : Object.keys(tableData[0] ?? {}).map((field) => ({ field, headerName: field }));

    return defs.map((col) => ({
      accessorKey: col.field,
      header: col.headerName || col.field,
      // `cell` is the TanStack option; the previous `cells:` key was not
      // recognised, so cellDataType never reached the renderer.
      cell: (info: { getValue: () => unknown }) => formatCell(info.getValue(), col),
      // Carries headerTooltip/width/etc. through to the header-row render below.
      meta: col,
    })) as TanstackColumnDef<Record<string, unknown>>[];
  }, [widgetDef.columnsDefs, tableData]);

  const table = useReactTable({
    data: tableData,
    columns,
    // Spec requires resizable columns. onChange updates as the handle moves;
    // onEnd would only commit on release and feels unresponsive.
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    initialState: {
      pagination: { pageSize: 20 },
    },
  });

  if (data === null || data === undefined) {
    return <div className="renderer-empty">No data available</div>;
  }

  // Present but not an array of rows: show the response instead of claiming
  // there is no data.
  if (!Array.isArray(data)) {
    return <RawJsonView data={data} widgetDef={widgetDef} theme={theme} />;
  }

  if (tableData.length === 0) {
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
                const meta = header.column.columnDef.meta as ColumnDef | undefined;
                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    title={meta?.headerTooltip}
                    // getSortedRowModel was registered but nothing could
                    // trigger it, so sorting was unreachable.
                    className="sortable"
                    style={{ width: header.getSize() }}
                    tabIndex={0}
                    // The whole header sorts; the resizer stops propagation so
                    // dragging it does not also toggle the sort.
                    onClick={header.column.getToggleSortingHandler()}
                    onKeyDown={(e) => {
                      if (e.repeat) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        header.column.getToggleSortingHandler()?.(e);
                      }
                    }}
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                    }
                  >
                    <span className="th-label">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </span>
                    {/* aria-hidden: aria-sort on the <th> already announces
                        direction to assistive tech; a glyph inside the label
                        text would have doubled it up. */}
                    <span aria-hidden="true">
                      {sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : ""}
                    </span>
                    {header.column.getCanResize() && (
                      <span
                        // Separate handle so dragging it does not also sort.
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
                <td key={cell.id}>
                  {flexRender(
                    cell.column.columnDef.cell,
                    cell.getContext()
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          {table.getFooterGroups().map((footerGroup) => (
            <tr key={footerGroup.id}>
              {footerGroup.headers.map((header) => (
                <th key={header.id}>
                  {flexRender(
                    header.column.columnDef.footer,
                    header.getContext()
                  )}
                </th>
              ))}
            </tr>
          ))}
        </tfoot>
      </table>
      <div className="table-pagination">
        <button
          onClick={() => table.setPageIndex(0)}
          disabled={!table.getCanPreviousPage()}
        >
          {"<<"}
        </button>
        <button
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage()}
        >
          {"<"}
        </button>
        <span>
          Page {table.getState().pagination.pageIndex + 1} of{" "}
          {table.getPageCount()}
        </span>
        <button
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage()}
        >
          {">"}
        </button>
        <button
          onClick={() => table.setPageIndex(table.getPageCount() - 1)}
          disabled={!table.getCanNextPage()}
        >
          {">>"}
        </button>
        <select
          value={table.getState().pagination.pageSize}
          onChange={(e) => {
            table.setPageSize(Number(e.target.value));
          }}
        >
          {[10, 20, 30, 40, 50].map((pageSize) => (
            <option key={pageSize} value={pageSize}>
              Show {pageSize}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}