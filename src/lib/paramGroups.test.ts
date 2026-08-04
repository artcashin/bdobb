import { describe, expect, it } from "vitest";
import { effectiveParams, groupedParamNames, splitParamEdit } from "./paramGroups";
import { makeWidgetDef } from "../test/widgetDef";
import type { DashboardCard, ParamGroup } from "./types";

const widget = makeWidgetDef({
  id: "w1",
  params: [
    { paramName: "symbol", label: "Symbol", type: "text", value: "MSFT", show: true },
    { paramName: "year", label: "Year", type: "text", value: "2024", show: true },
  ] as never,
});

const GROUP: ParamGroup = { id: "g1", name: "Group 1", paramName: "symbol", value: "AAPL" };

function card(over: Partial<DashboardCard> = {}): DashboardCard {
  return {
    uuid: "c1",
    widgetId: "w1",
    backendId: "b1",
    layout: { x: 0, y: 0, w: 10, h: 5 },
    params: { symbol: "MSFT", year: "2024" },
    view: "default",
    ...over,
  };
}

describe("effectiveParams", () => {
  it("lets the group value win over the card's own", () => {
    // The card's stored value for a grouped parameter is stale by definition:
    // it is whatever the card held before joining. Letting it win would make
    // the group visibly do nothing.
    const values = effectiveParams(widget, card({ groups: ["g1"] }), [GROUP]);
    expect(values).toEqual({ symbol: "AAPL", year: "2024" });
  });

  it("leaves an ungrouped card untouched", () => {
    const c = card();
    expect(effectiveParams(widget, c, [GROUP])).toBe(c.params);
  });

  it("ignores a group whose parameter the widget does not declare", () => {
    // A card can belong to a group its widget has no parameter for. Binding
    // anyway would append a query parameter the endpoint never asked for.
    const other: ParamGroup = { id: "g2", name: "G2", paramName: "sector", value: "Tech" };
    const values = effectiveParams(widget, card({ groups: ["g2"] }), [other]);
    expect(values).toEqual({ symbol: "MSFT", year: "2024" });
    expect(values).not.toHaveProperty("sector");
  });

  it("ignores a group id that no longer exists", () => {
    const values = effectiveParams(widget, card({ groups: ["deleted"] }), [GROUP]);
    expect(values).toEqual({ symbol: "MSFT", year: "2024" });
  });

  it("applies several groups at once", () => {
    const yearGroup: ParamGroup = { id: "g2", name: "G2", paramName: "year", value: "2019" };
    const values = effectiveParams(widget, card({ groups: ["g1", "g2"] }), [GROUP, yearGroup]);
    expect(values).toEqual({ symbol: "AAPL", year: "2019" });
  });
});

describe("groupedParamNames", () => {
  it("names only the parameters the widget actually declares", () => {
    const other: ParamGroup = { id: "g2", name: "G2", paramName: "sector", value: "Tech" };
    const names = groupedParamNames(widget, card({ groups: ["g1", "g2"] }), [GROUP, other]);
    expect([...names]).toEqual(["symbol"]);
  });

  it("is empty for a widget that failed to resolve", () => {
    expect(groupedParamNames(undefined, card({ groups: ["g1"] }), [GROUP]).size).toBe(0);
  });
});

describe("splitParamEdit", () => {
  it("routes a grouped edit to the group and the rest to the card", () => {
    const { cardParams, groupUpdates } = splitParamEdit(
      widget,
      card({ groups: ["g1"] }),
      [GROUP],
      { symbol: "NVDA", year: "2023" }
    );
    // symbol belongs to the group; writing it onto the card would persist a
    // value the group masks on the next render, so the control would snap back.
    expect(cardParams).toEqual({ year: "2023" });
    expect(groupUpdates).toEqual([{ id: "g1", value: "NVDA" }]);
  });

  it("reports no group update when the shared value did not change", () => {
    // Writing every group on each Apply would refetch every member card
    // whether or not anything moved.
    const { groupUpdates } = splitParamEdit(widget, card({ groups: ["g1"] }), [GROUP], {
      symbol: "AAPL",
      year: "2023",
    });
    expect(groupUpdates).toEqual([]);
  });

  it("passes everything through for an ungrouped card", () => {
    const edited = { symbol: "NVDA", year: "2023" };
    const { cardParams, groupUpdates } = splitParamEdit(widget, card(), [GROUP], edited);
    expect(cardParams).toBe(edited);
    expect(groupUpdates).toEqual([]);
  });
});
