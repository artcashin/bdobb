import type {
  ColumnDef, GridData, ParamDef, ParamOption, ParamType, WidgetDef,
} from "./types";

const PARAM_TYPES: ParamType[] = [
  "date", "text", "ticker", "number", "boolean", "endpoint", "form", "tabs",
];

function asRecord(x: unknown): Record<string, unknown> | null {
  return x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : null;
}

function parseParam(raw: Record<string, unknown>): ParamDef | null {
  const paramName = typeof raw.paramName === "string" ? raw.paramName : null;
  if (!paramName) return null;
  const rawType = typeof raw.type === "string" ? raw.type : "text";
  const type: ParamType = (PARAM_TYPES as string[]).includes(rawType)
    ? (rawType as ParamType)
    : "text";
  let options: ParamOption[] | null = null;
  if (Array.isArray(raw.options)) {
    options = raw.options
      .map((o) => asRecord(o))
      .filter((o): o is Record<string, unknown> => o !== null)
      .map((o) => ({
        label: String(o.label ?? o.value ?? ""),
        value: (o.value ?? "") as string | number | boolean,
      }));
  }
  const optionsParams = asRecord(raw.optionsParams);
  return {
    paramName,
    type,
    value: (raw.value ?? null) as ParamDef["value"],
    label: typeof raw.label === "string" ? raw.label : paramName,
    description: typeof raw.description === "string" ? raw.description : "",
    show: raw.show !== false,
    multiSelect: raw.multiSelect === true || raw.multiple === true,
    options,
    optionsEndpoint:
      typeof raw.optionsEndpoint === "string" ? raw.optionsEndpoint : null,
    optionsParams: optionsParams
      ? (Object.fromEntries(
          Object.entries(optionsParams).map(([k, v]) => [k, String(v)])
        ) as Record<string, string>)
      : null,
  };
}

export function parseWidgetEntry(
  id: string,
  raw: Record<string, unknown>,
  backendId: string = ""
): WidgetDef {
  const type = typeof raw.type === "string" && raw.type !== "" ? raw.type : "table";
  let endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  if (type !== "iframe" && endpoint !== "" && !endpoint.startsWith("/")) {
    endpoint = `/${endpoint}`;
  }
  // live_grid: the websocket endpoint streaming row updates. Same
  // normalization as `endpoint` — resolveWsUrl strips the leading slash and
  // pins it under the backend's base path, so it cannot retarget the origin.
  let wsEndpoint = typeof raw.wsEndpoint === "string" ? raw.wsEndpoint : "";
  if (wsEndpoint !== "" && !wsEndpoint.startsWith("/")) {
    wsEndpoint = `/${wsEndpoint}`;
  }
  const source =
    typeof raw.source === "string"
      ? [raw.source]
      : Array.isArray(raw.source)
        ? raw.source.map((s) => String(s))
        : [];
  const gridRaw = asRecord(raw.gridData);
  const gridData: GridData = {
    w: typeof gridRaw?.w === "number" ? gridRaw.w : 20,
    h: typeof gridRaw?.h === "number" ? gridRaw.h : 12,
    ...(typeof gridRaw?.minW === "number" ? { minW: gridRaw.minW } : {}),
    ...(typeof gridRaw?.minH === "number" ? { minH: gridRaw.minH } : {}),
    ...(typeof gridRaw?.maxW === "number" ? { maxW: gridRaw.maxW } : {}),
    ...(typeof gridRaw?.maxH === "number" ? { maxH: gridRaw.maxH } : {}),
  };
  const data = asRecord(raw.data);
  const dataKeyRaw = typeof data?.dataKey === "string" ? data.dataKey : "";
  const table = asRecord(data?.table);
  // Validate rather than cast. An entry without a string `field` reaches
  // chartShapes and TableRenderer, which read `.field` unguarded — and
  // canToggleChart runs in WidgetCard's render body, outside its error
  // boundary, so one bad entry from widgets.json took the whole app down.
  const columnsDefs = Array.isArray(table?.columnsDefs)
    ? (table!.columnsDefs as unknown[])
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => c !== null && typeof c.field === "string")
        .map((c) => c as unknown as ColumnDef)
    : null;
  const storage = asRecord(raw.storage);
  const params = Array.isArray(raw.params)
    ? raw.params
        .map((p) => asRecord(p))
        .filter((p): p is Record<string, unknown> => p !== null)
        .map(parseParam)
        .filter((p): p is ParamDef => p !== null)
    : [];
  const refetch = raw.refetchInterval;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    description: typeof raw.description === "string" ? raw.description : "",
    category: typeof raw.category === "string" ? raw.category : "Other",
    subCategory:
      typeof raw.subCategory === "string" ? raw.subCategory : null,
    type,
    endpoint,
    gridData,
    source,
    runButton: raw.runButton === true,
    raw: raw.raw === true,
    refetchInterval:
      typeof refetch === "number" || typeof refetch === "string" || refetch === false
        ? refetch
        : null,
    params,
    dataKey: dataKeyRaw === "" ? null : dataKeyRaw,
    wsEndpoint: wsEndpoint === "" ? null : wsEndpoint,
    wsRowIdColumn:
      typeof data?.wsRowIdColumn === "string" && data.wsRowIdColumn !== ""
        ? data.wsRowIdColumn
        : null,
    columnsDefs,
    mcpUrl: typeof storage?.mcpUrl === "string" ? storage.mcpUrl : null,
    backendId,
  };
}

export function parseWidgetsJson(json: unknown, backendId: string = ""): WidgetDef[] {
  const obj = asRecord(json);
  if (!obj) return [];
  const out: WidgetDef[] = [];
  for (const [id, entry] of Object.entries(obj)) {
    const rec = asRecord(entry);
    if (rec) out.push(parseWidgetEntry(id, rec, backendId));
  }
  return out;
}
