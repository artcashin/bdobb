import { describe, expect, it } from "vitest";
import {
  resolveDefaultValue, initialParamValues, resolveOptionsParams, normalizeOptions,
} from "./params";
import { makeWidgetDef } from "../test/widgetDef";
import type { ParamDef } from "./types";

// Mid-month, mid-year, so offsets do not accidentally straddle a boundary.
const NOW = new Date(2026, 6, 15, 12, 0, 0); // 2026-07-15 local

describe("resolveDefaultValue", () => {
  it("resolves a bare $currentDate to today", () => {
    expect(resolveDefaultValue("$currentDate", NOW)).toBe("2026-07-15");
  });

  it("applies day, week, month and year offsets", () => {
    expect(resolveDefaultValue("$currentDate-1d", NOW)).toBe("2026-07-14");
    expect(resolveDefaultValue("$currentDate+3d", NOW)).toBe("2026-07-18");
    expect(resolveDefaultValue("$currentDate-1w", NOW)).toBe("2026-07-08");
    expect(resolveDefaultValue("$currentDate-1M", NOW)).toBe("2026-06-15");
    expect(resolveDefaultValue("$currentDate-1y", NOW)).toBe("2025-07-15");
  });

  it("clamps a month offset that would overflow a short month", () => {
    // Jan 31 minus one month has no 31st to land on; naive setMonth rolls
    // forward into March.
    const jan31 = new Date(2026, 0, 31, 12);
    expect(resolveDefaultValue("$currentDate-1M", jan31)).toBe("2025-12-31");
    const mar31 = new Date(2026, 2, 31, 12);
    expect(resolveDefaultValue("$currentDate-1M", mar31)).toBe("2026-02-28");
    // Forward overflow and year-unit overflow clamp the same way.
    const may31 = new Date(2026, 4, 31, 12);
    expect(resolveDefaultValue("$currentDate-1M", may31)).toBe("2026-04-30");
    expect(resolveDefaultValue("$currentDate+1M", jan31)).toBe("2026-02-28");
    // Leap-year Feb 29 crossing into/out of a non-leap year.
    const leapFeb29 = new Date(2024, 1, 29, 12);
    expect(resolveDefaultValue("$currentDate-1y", leapFeb29)).toBe("2023-02-28");
    expect(resolveDefaultValue("$currentDate+1y", leapFeb29)).toBe("2025-02-28");
  });

  it("trims surrounding whitespace before matching", () => {
    expect(resolveDefaultValue("  $currentDate-1d  ", NOW)).toBe("2026-07-14");
  });

  it("uses the local date, not UTC", () => {
    // Late evening local is already tomorrow in UTC; toISOString would report
    // the wrong day for anyone west of Greenwich.
    const lateEvening = new Date(2026, 6, 15, 23, 30);
    expect(resolveDefaultValue("$currentDate", lateEvening)).toBe("2026-07-15");
  });

  it("returns anything else unchanged", () => {
    expect(resolveDefaultValue("AAPL", NOW)).toBe("AAPL");
    expect(resolveDefaultValue("", NOW)).toBe("");
    // Near-misses must not silently resolve.
    expect(resolveDefaultValue("$currentDate-1", NOW)).toBe("$currentDate-1");
    expect(resolveDefaultValue("$currentdate", NOW)).toBe("$currentdate");
    expect(resolveDefaultValue("$currentDate-1m", NOW)).toBe("$currentDate-1m");
  });
});

function param(over: Partial<ParamDef>): ParamDef {
  return {
    paramName: "p", type: "text", value: null, label: "P", description: "",
    show: true, multiSelect: false, options: null, optionsEndpoint: null,
    optionsParams: null, ...over,
  } as ParamDef;
}

describe("initialParamValues", () => {
  it("seeds each param from its default, resolving date expressions", () => {
    const widget = makeWidgetDef({
      params: [
        param({ paramName: "symbol", value: "AAPL" }),
        param({ paramName: "start_date", type: "date", value: "$currentDate-1w" }),
      ],
    });
    expect(initialParamValues(widget, NOW)).toEqual({
      symbol: "AAPL",
      start_date: "2026-07-08",
    });
  });

  it("includes hidden params, which are sent but not editable", () => {
    const widget = makeWidgetDef({
      params: [param({ paramName: "provider", value: "eodhd", show: false })],
    });
    expect(initialParamValues(widget, NOW)).toEqual({ provider: "eodhd" });
  });

  it("preserves non-string defaults as they are", () => {
    const widget = makeWidgetDef({
      params: [
        param({ paramName: "limit", type: "number", value: 50 }),
        param({ paramName: "adjusted", type: "boolean", value: true }),
        param({ paramName: "none", value: null }),
      ],
    });
    expect(initialParamValues(widget, NOW)).toEqual({ limit: 50, adjusted: true, none: null });
  });
});

describe("resolveOptionsParams", () => {
  it("substitutes $refs from current values and keeps literals", () => {
    expect(
      resolveOptionsParams(
        { dataflow_group: "$dataflow_group", fixed: "yes" },
        { dataflow_group: "BOP", table: null }
      )
    ).toEqual({ dataflow_group: "BOP", fixed: "yes" });
  });

  it("maps missing refs to null and null input to empty", () => {
    expect(resolveOptionsParams({ a: "$missing" }, {})).toEqual({ a: null });
    expect(resolveOptionsParams(null, {})).toEqual({});
  });
});

describe("normalizeOptions", () => {
  it("accepts {label,value} arrays and scalar arrays", () => {
    expect(normalizeOptions([{ label: "One", value: 1 }])).toEqual([
      { label: "One", value: 1 },
    ]);
    expect(normalizeOptions(["a", "b"])).toEqual([
      { label: "a", value: "a" }, { label: "b", value: "b" },
    ]);
    expect(normalizeOptions({ nope: true })).toEqual([]);
  });

  it("falls back label<->value when only one is present, and drops junk entries", () => {
    expect(normalizeOptions([{ value: 42 }])).toEqual([{ label: "42", value: 42 }]);
    expect(normalizeOptions([{ label: "Only label" }])).toEqual([
      { label: "Only label", value: "Only label" },
    ]);
    expect(normalizeOptions([{ nope: true }, null, 5])).toEqual([{ label: "5", value: 5 }]);
  });
});
