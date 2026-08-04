import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ColumnDef } from "../../lib/types";
import historical from "../../test/fixtures/historical.fixture.json";
import TableRenderer, { formatCell, orderColumns } from "./TableRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const ROWS = [
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
];

describe("formatCell", () => {
  it("formats dates to YYYY-MM-DD", () => {
    expect(formatCell("2026-07-01", { field: "d", cellDataType: "date" })).toBe("2026-07-01");
  });

  it("formats numbers with locale separators and decimalPlaces", () => {
    expect(formatCell(50164200, { field: "v", cellDataType: "number" })).toBe("50,164,200");
    expect(formatCell(294.381, { field: "c", cellDataType: "number", decimalPlaces: 2 })).toBe("294.38");
  });

  it("applies formatterFn int and percent, prefix and suffix", () => {
    expect(formatCell(1234.6, { field: "x", formatterFn: "int" })).toBe("1,235");
    expect(formatCell(0.1234, { field: "x", formatterFn: "percent" })).toBe("12.34%");
    expect(formatCell(5, { field: "x", cellDataType: "number", prefix: "$", suffix: "M" })).toBe("$5M");
  });

  it("renders null/undefined as empty and objects as JSON", () => {
    expect(formatCell(null, { field: "x" })).toBe("");
    expect(formatCell({ a: 1 }, { field: "x", cellDataType: "object" })).toBe('{"a":1}');
  });

  it("never renders NaN and never fabricates 0 for empty/array/boolean values in a numeric column", () => {
    const col: ColumnDef = { field: "x", cellDataType: "number" };
    expect(formatCell(NaN, col)).toBe("—");
    expect(formatCell("", col)).toBe("—");
    expect(formatCell([], col)).toBe("—");
    expect(formatCell(true, col)).toBe("—");
    expect(formatCell(null, col)).toBe("");
    expect(formatCell(undefined, col)).toBe("");
    expect(formatCell("294.38", col)).toBe("294.38");
  });

  it("never renders NaN for formatterFn int or percent either", () => {
    expect(formatCell(NaN, { field: "x", formatterFn: "int" })).toBe("—");
    expect(formatCell(NaN, { field: "x", formatterFn: "percent" })).toBe("—");
  });

  it("applies int/percent formatterFn to numeric strings, not just numbers", () => {
    expect(formatCell("0.1234", { field: "x", formatterFn: "percent" })).toBe("12.34%");
    expect(formatCell("1234.6", { field: "x", formatterFn: "int" })).toBe("1,235");
  });

  it("formats numeric strings the same as numbers within one percent column", () => {
    const col: ColumnDef = { field: "x", cellDataType: "number", formatterFn: "percent" };
    expect(formatCell(0.1234, col)).toBe(formatCell("0.1234", col));
    expect(formatCell(0.1234, col)).toBe("12.34%");
  });

  it("returns the missing-value marker (not a bare prefix) for an empty string under formatterFn percent", () => {
    expect(formatCell("", { field: "x", formatterFn: "percent", prefix: "$" })).toBe("—");
  });

  it("takes the calendar date verbatim from a datetime string, never UTC-shifting it", () => {
    const col: ColumnDef = { field: "d", cellDataType: "date" };
    expect(formatCell("2026-07-01", col)).toBe("2026-07-01");
    // 8pm ET on 2026-07-01 is 2026-07-02 in UTC — must stay on the 1st.
    expect(formatCell("2026-07-01T20:00:00-04:00", col)).toBe("2026-07-01");
    expect(formatCell("2026-07-01T20:00:00Z", col)).toBe("2026-07-01");
    expect(formatCell("not-a-date", col)).toBe("not-a-date");
  });

  it("still honors legacy cellDataType: 'percent' fixtures (not part of the typed CellDataType union)", () => {
    expect(formatCell(0.1234, { field: "pct", cellDataType: "percent" as ColumnDef["cellDataType"] })).toBe(
      "12.34%"
    );
  });
});

describe("orderColumns", () => {
  it("drops hidden columns and orders pinned left/right", () => {
    const cols: ColumnDef[] = [
      { field: "mid" },
      { field: "right", pinned: "right" },
      { field: "gone", hide: true },
      { field: "left", pinned: "left" },
    ];
    expect(orderColumns(cols).map((c) => c.field)).toEqual(["left", "mid", "right"]);
  });
});

const withCols = makeWidgetDef({
  columnsDefs: [
    { field: "name", headerName: "Name" },
    { field: "age", headerName: "Age" },
  ] as any,
});

describe("TableRenderer", () => {
  it("renders rows using columnsDefs", () => {
    render(<TableRenderer data={ROWS} widgetDef={withCols} theme="dark" />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("derives columns from the data when columnsDefs is absent", () => {
    // Without this fallback a widgets.json entry lacking columnsDefs produced
    // a table with zero columns — a blank card despite having data.
    render(<TableRenderer data={ROWS} widgetDef={makeWidgetDef()} theme="dark" />);
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("sorts when a header is clicked, and reverses on a second click", () => {
    // getSortedRowModel was registered but no header could trigger it, so
    // sorting was unreachable. Assert the toggle rather than a specific first
    // direction — TanStack sorts numeric columns descending first.
    render(<TableRenderer data={ROWS} widgetDef={withCols} theme="dark" />);
    const header = screen.getByText("Age").closest("th")!;
    expect(header.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(header);
    const first = header.getAttribute("aria-sort");
    expect(first).not.toBe("none");
    const firstCell = () => screen.getAllByRole("row")[1].textContent;
    const afterFirst = firstCell();

    fireEvent.click(header);
    expect(header.getAttribute("aria-sort")).not.toBe(first);
    expect(firstCell()).not.toBe(afterFirst);
  });

  it("formats cells according to cellDataType", () => {
    const def = makeWidgetDef({
      columnsDefs: [{ field: "pct", headerName: "Pct", cellDataType: "percent" }] as any,
    });
    render(<TableRenderer data={[{ pct: 0.1234 }]} widgetDef={def} theme="dark" />);
    expect(screen.getByText("12.34%")).toBeInTheDocument();
  });

  it("shows an empty state when there is no data", () => {
    render(<TableRenderer data={null} widgetDef={withCols} theme="dark" />);
    expect(screen.getByText(/No data available/i)).toBeInTheDocument();
  });

  it("falls back to raw JSON when the payload is not an array of rows", () => {
    render(
      <TableRenderer data={{ error: "upstream boom" }} widgetDef={withCols} theme="dark" />
    );
    expect(screen.getByText(/upstream boom/)).toBeInTheDocument();
  });

  it("offers a resize handle per column that does not trigger sorting", () => {
    // Spec requires resizable columns; the handle must be separate from the
    // sort target or every drag would also reorder the table.
    render(<TableRenderer data={ROWS} widgetDef={withCols} theme="dark" />);
    const handles = screen.getAllByRole("separator");
    expect(handles).toHaveLength(2);

    const header = screen.getByText("Age").closest("th")!;
    const before = header.getAttribute("aria-sort");
    fireEvent.click(handles[1]);
    expect(header.getAttribute("aria-sort")).toBe(before);
  });

  it("renders headerTooltip and formats fixture cells (date, locale number)", () => {
    const def = makeWidgetDef({
      columnsDefs: [
        { field: "date", headerName: "Date", headerTooltip: "The date of the data.", cellDataType: "date", pinned: "left" },
        { field: "close", headerName: "Close", cellDataType: "number" },
        { field: "volume", headerName: "Volume", cellDataType: "number" },
      ] as ColumnDef[],
    });
    render(<TableRenderer data={historical.results} widgetDef={def} theme="dark" />);
    expect(screen.getByText("Date")).toBeInTheDocument();
    expect(screen.getByTitle("The date of the data.")).toBeInTheDocument();
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getByText("50,164,200")).toBeInTheDocument();
  });
});

describe("TableRenderer sortable headers accessibility", () => {
  const def = makeWidgetDef({
    columnsDefs: [
      { field: "a", headerName: "A" },
      { field: "b", headerName: "B" },
    ] as ColumnDef[],
  });
  const records = [{ a: 1, b: 2 }, { a: 3, b: 4 }];

  it("sets aria-sort none/descending/ascending across clicks and hides the sort glyph from assistive tech", () => {
    render(<TableRenderer data={records} widgetDef={def} theme="dark" />);
    const th = screen.getByText("A").closest("th")!;
    expect(th).toHaveAttribute("aria-sort", "none");
    // Numeric columns sort descending-first by TanStack's default.
    fireEvent.click(screen.getByText("A"));
    expect(th).toHaveAttribute("aria-sort", "descending");
    const glyph = th.querySelector("[aria-hidden='true']");
    expect(glyph).toBeInTheDocument();
    expect(glyph).toHaveTextContent("▼");
    fireEvent.click(screen.getByText("A"));
    expect(th).toHaveAttribute("aria-sort", "ascending");
    expect(th.querySelector("[aria-hidden='true']")).toHaveTextContent("▲");
  });

  it("is keyboard-operable via Enter/Space and ignores held-key repeat", () => {
    render(<TableRenderer data={records} widgetDef={def} theme="dark" />);
    const th = screen.getByText("A").closest("th")!;
    expect(th).toHaveAttribute("tabIndex", "0");
    fireEvent.keyDown(th, { key: "Enter" });
    expect(th).toHaveAttribute("aria-sort", "descending");
    fireEvent.keyDown(th, { key: "Enter", repeat: true });
    expect(th).toHaveAttribute("aria-sort", "descending"); // repeat ignored, no double-toggle
    fireEvent.keyDown(th, { key: " " });
    expect(th).toHaveAttribute("aria-sort", "ascending");
  });

  it("scopes the pointer cursor to sortable headers via a class, not every header", () => {
    render(<TableRenderer data={records} widgetDef={def} theme="dark" />);
    const th = screen.getByText("A").closest("th")!;
    expect(th.className).toContain("sortable");
  });
});

describe("TableRenderer cell formatting regression", () => {
  it("re-renders cell content when columnsDefs changes even though the data array identity is unchanged", () => {
    const records = [{ v: 0.5 }, { v: 0.25 }];
    const numberDef = makeWidgetDef({
      columnsDefs: [{ field: "v", cellDataType: "number", decimalPlaces: 4 }] as ColumnDef[],
    });
    const percentDef = makeWidgetDef({
      columnsDefs: [{ field: "v", formatterFn: "percent" }] as ColumnDef[],
    });

    const { rerender } = render(
      <TableRenderer data={records} widgetDef={numberDef} theme="dark" />
    );
    expect(screen.getByText("0.5000")).toBeInTheDocument();
    expect(screen.getByText("0.2500")).toBeInTheDocument();

    // Same `data` reference, only widgetDef.columnsDefs changes.
    rerender(<TableRenderer data={records} widgetDef={percentDef} theme="dark" />);

    expect(screen.getByText("50.00%")).toBeInTheDocument();
    expect(screen.getByText("25.00%")).toBeInTheDocument();
    expect(screen.queryByText("0.5000")).not.toBeInTheDocument();
    expect(screen.queryByText("0.2500")).not.toBeInTheDocument();
  });
});
