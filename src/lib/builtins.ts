import type { ParamDef, WidgetDef } from "./types";

/**
 * Widgets BDOBB supplies itself, with no backend behind them.
 *
 * Every other widget is described by a backend's widgets.json and its data
 * comes from an HTTP round trip. These have neither — a note is text the user
 * typed, a clock is the system time. OpenBB Workspace calls the equivalent
 * "core widgets" and ships five; these are the two that need no network and no
 * design decisions about existing chrome.
 *
 * They travel through the normal DashboardCard model rather than a parallel
 * one: a reserved backendId keeps layout, persistence, import and export
 * working unchanged, and confines the special case to "do not fetch".
 */
export const BUILTIN_BACKEND_ID = "builtin";

export const BUILTIN_NOTE_ID = "builtin:note";
export const BUILTIN_CLOCK_ID = "builtin:clock";
export const BUILTIN_WEBSITE_ID = "builtin:website";

/** Where a note's text lives — a card param, so it persists with the card. */
export const NOTE_TEXT_PARAM = "text";
/**
 * Comma-separated IANA zone names. Replaces the older single-zone `timezone`
 * param, which is still read as a fallback so cards created before the widget
 * became a list keep working.
 */
export const CLOCK_ZONES_PARAM = "zones";
/** Legacy single-zone param, still honoured when `zones` is empty. */
export const CLOCK_TZ_PARAM = "timezone";
/** Legacy boolean, still honoured when `hourCycle` is unset. */
export const CLOCK_HOUR12_PARAM = "hour12";
/** "12" or "24". */
export const CLOCK_CYCLE_PARAM = "hourCycle";
/** "dots" for the matrix face, "solid" for the filled one. */
export const CLOCK_FACE_PARAM = "face";

export const CLOCK_DEFAULT_ZONES =
  "America/New_York,America/Chicago,America/Los_Angeles,Europe/London," +
  "Asia/Shanghai,Asia/Tokyo,Australia/Sydney";
/** Address the Website widget frames. */
export const WEBSITE_URL_PARAM = "url";

function param(over: Partial<ParamDef> & { paramName: string; label: string }): ParamDef {
  return {
    type: "text",
    value: "",
    description: "",
    show: true,
    multiSelect: false,
    options: null,
    optionsEndpoint: null,
    optionsParams: null,
    ...over,
  };
}


function def(over: Partial<WidgetDef> & { id: string; name: string; type: string }): WidgetDef {
  return {
    description: "",
    category: "Built-in",
    subCategory: null,
    endpoint: "",
    gridData: { w: 12, h: 8 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: null,
    wsEndpoint: null,
    wsRowIdColumn: null,
    columnsDefs: null,
    mcpUrl: null,
    backendId: BUILTIN_BACKEND_ID,
    ...over,
  };
}

export const BUILTIN_WIDGETS: WidgetDef[] = [
  def({
    id: BUILTIN_NOTE_ID,
    name: "Note",
    type: "note",
    description: "A free-text note. Click to edit; saved with the dashboard.",
    gridData: { w: 15, h: 8 },
    params: [
      // Hidden from the parameter panel: a note is edited in place, and a
      // single-line text control is the wrong shape for prose.
      param({ paramName: NOTE_TEXT_PARAM, label: "Text", show: false }),
    ],
  }),
  def({
    id: BUILTIN_WEBSITE_ID,
    name: "Website",
    type: "iframe",
    description: "Frames any web page. Some sites refuse to be embedded.",
    gridData: { w: 24, h: 16 },
    params: [
      param({
        paramName: WEBSITE_URL_PARAM,
        label: "URL",
        description:
          "https:// or http:// address. Many sites refuse to be embedded — " +
          "Google, most banks and most webmail send X-Frame-Options and will " +
          "show blank. Use Open externally for those.",
      }),
    ],
  }),
  def({
    id: BUILTIN_CLOCK_ID,
    name: "Clock",
    type: "clock",
    description: "Current time across several markets.",
    // A list, so it wants height rather than the small square a single clock did.
    gridData: { w: 22, h: 16 },
    params: [
      param({
        paramName: CLOCK_ZONES_PARAM,
        label: "Time zones",
        description: "Comma-separated IANA zone names, in display order.",
        value: CLOCK_DEFAULT_ZONES,
      }),
      param({
        paramName: CLOCK_CYCLE_PARAM,
        label: "Hour format",
        description: "12-hour appends A or P.",
        value: "24",
        options: [
          { label: "24-hour", value: "24" },
          { label: "12-hour", value: "12" },
        ],
      }),
      param({
        paramName: CLOCK_FACE_PARAM,
        label: "Typeface",
        description: "The matrix face needs roughly 32px to read as dots on a non-HiDPI display.",
        value: "dots",
        options: [
          { label: "Dot matrix", value: "dots" },
          { label: "Solid", value: "solid" },
        ],
      }),
    ],
  }),
];

export function isBuiltinBackend(backendId: string): boolean {
  return backendId === BUILTIN_BACKEND_ID;
}

export function findBuiltin(widgetId: string): WidgetDef | undefined {
  return BUILTIN_WIDGETS.find((w) => w.id === widgetId);
}
