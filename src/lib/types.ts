// ---- widgets.json protocol (normalized) ----

export type ParamType =
  | "date" | "text" | "ticker" | "number" | "boolean"
  | "endpoint" | "form" | "tabs";

export interface ParamOption {
  label: string;
  value: string | number | boolean;
}

export interface ParamDef {
  paramName: string;
  type: ParamType;
  value: string | number | boolean | string[] | null;
  label: string;
  description: string;
  /** false => control hidden, value still sent */
  show: boolean;
  /** normalized: raw multiSelect || multiple */
  multiSelect: boolean;
  options: ParamOption[] | null;
  optionsEndpoint: string | null;
  /** values may be "$otherParamName" references */
  optionsParams: Record<string, string> | null;
}

export type CellDataType =
  | "text" | "number" | "boolean" | "date" | "dateString" | "object";

export type FormatterFn =
  | "int" | "none" | "percent" | "normalized"
  | "normalizedPercent" | "dateToYear";

export interface ColumnDef {
  field: string;
  headerName?: string;
  headerTooltip?: string;
  cellDataType?: CellDataType;
  formatterFn?: FormatterFn | null;
  decimalPlaces?: number;
  prefix?: string;
  suffix?: string;
  hide?: boolean;
  pinned?: "left" | "right";
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** live_grid: "greenRed" colors by the cell's own sign; "showCellChange"
   * colors by the sign of renderFnParams.colorValueKey's value in the row */
  renderFn?: string;
  renderFnParams?: { colorValueKey?: string };
  /** live_grid: false suppresses the cell-change flash for this column
   * (e.g. volume, which changes on every tick) */
  enableCellChangeWs?: boolean;
}

export interface GridData {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface WidgetDef {
  id: string;
  name: string;
  description: string;
  category: string;
  subCategory: string | null;
  /** "table" (default) | "chart" | "html" | "iframe" | "markdown" | "metric" | "multi_file_viewer" | "pdf" | anything else */
  type: string;
  /** normalized to a leading "/" — EXCEPT type === "iframe", where it is a full URL used verbatim as iframe src */
  endpoint: string;
  gridData: GridData;
  source: string[];
  runButton: boolean;
  /** widget supports ?raw=true raw-data view */
  raw: boolean;
  /** parsed but IGNORED in v1 (no refresh scheduling) */
  refetchInterval: number | string | false | null;
  params: ParamDef[];
  dataKey: string | null;
  /** live_grid: websocket endpoint streaming row updates; normalized to a
   * leading "/" like `endpoint`. Optional (not `| null` required) so the many
   * pre-live_grid WidgetDef literals in tests stay valid; the parser always
   * sets it. */
  wsEndpoint?: string | null;
  /** live_grid (data.wsRowIdColumn): the column whose value identifies which
   * row a streamed update belongs to */
  wsRowIdColumn?: string | null;
  columnsDefs: ColumnDef[] | null;
  /** storage.mcpUrl — MCP server to auto-connect while widget is on the active dashboard */
  mcpUrl: string | null;
  backendId: string;
}

// ---- app domain ----

export interface BackendConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** optional auth header applied to every request to this backend */
  headerName?: string;
  headerValue?: string;
}

import type { ShareTarget } from "./chatShare";

export type ParamValues = Record<string, string | number | boolean | string[] | null>;

export interface WidgetParams {
  pod: string;
  id: string;
  pid: string;
}

export interface CardLayout { x: number; y: number; w: number; h: number; }

export type CardView = "default" | "raw" | "chart";

export interface DashboardCard {
  uuid: string;
  widgetId: string;
  backendId: string;
  layout: CardLayout;
  params: ParamValues;
  view: CardView;
  /**
   * Ids of the parameter groups this card belongs to. A grouped parameter is
   * read from the group instead of from `params`, so several cards move
   * together — pick a ticker on one, every card in the group follows.
   */
  groups?: string[];
}

/**
 * One parameter value shared across cards. OpenBB Workspace calls these
 * groups and scopes them to an app; BDOBB scopes them to a dashboard, which
 * matches how they are used in practice and keeps a change on one dashboard
 * from silently refetching cards on another.
 */
export interface ParamGroup {
  id: string;
  /** Display name, preserved so an export round trip keeps Workspace's naming. */
  name: string;
  /** The parameter this group binds, matched against a widget's paramName. */
  paramName: string;
  value: ParamValues[string];
}

export interface Dashboard {
  id: string;
  name: string;
  cards: DashboardCard[];
  groups?: ParamGroup[];
  /**
   * The app this dashboard belongs to, if any.
   *
   * OpenBB Workspace nests tabs inside an app and puts a navigation bar across
   * them; BDOBB's dashboard strip is that navigation bar, but its list was flat,
   * so importing a 14-tab app produced 14 siblings with nothing recording that
   * they belong together. Dashboards sharing an appName are shown as one
   * section and export back to one app.
   */
  appName?: string;
}

export interface McpServerConfig {
  id: string;
  url: string;
  enabled: boolean;
}

export interface Settings {
  ritaUrl: string;
  theme: "dark";
  contextSharing: boolean;
  mcpServers: McpServerConfig[];
  /** Places a conversation can be sent (Tolaria, Notion, a webhook…). */
  shareTargets?: ShareTarget[];
}
