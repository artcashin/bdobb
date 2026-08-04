import type { WidgetDef } from "../lib/types";

/** Minimal valid WidgetDef for renderer tests; override only what matters. */
export function makeWidgetDef(over: Partial<WidgetDef> = {}): WidgetDef {
  return {
    id: "test-widget",
    name: "Test Widget",
    description: "",
    category: "Test",
    subCategory: null,
    type: "table",
    endpoint: "/test",
    gridData: { w: 40, h: 15 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: null,
    columnsDefs: null,
    mcpUrl: null,
    backendId: "test",
    ...over,
  } as WidgetDef;
}
