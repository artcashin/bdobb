import type { BackendConfig, ParamValues, WidgetDef } from "./types";

/** What the deployment can do with a provider's widgets. */
export type ProviderKeyStatus = "keyed" | "unkeyed" | "unknown";

/** One row of key-maint's GET /keys response. */
export interface KeyMaintRow {
  provider: string;
  env_var?: string;
  status: string;
  demo?: boolean;
}

/**
 * widgets.json says "Eodhd" / "Alpha_vantage"; key-maint says "EODHD" /
 * "Alpha Vantage". Lowercasing and stripping every non-alphanumeric makes
 * them meet in the middle. A parenthetical suffix is dropped first so
 * "Alpaca (secret)" folds into "alpaca" and participates in the pairing
 * rule in parseKeyMaintRows instead of surfacing as its own provider.
 */
export function normalizeProvider(name: string): string {
  return name
    .replace(/\(.*?\)/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Rows sharing a normalized provider are one credential set: keyed only if
 * every row is "set", unkeyed as soon as any is "empty", unknown otherwise.
 * That is exactly the alpaca key+secret pairing, without special-casing
 * alpaca — any future multi-var provider gets the same treatment.
 */
export function parseKeyMaintRows(rows: KeyMaintRow[]): Record<string, ProviderKeyStatus> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const key = normalizeProvider(row.provider);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row.status]);
  }
  const out: Record<string, ProviderKeyStatus> = {};
  for (const [key, statuses] of grouped) {
    if (statuses.some((s) => s === "empty")) out[key] = "unkeyed";
    else if (statuses.every((s) => s === "set")) out[key] = "keyed";
    else out[key] = "unknown";
  }
  return out;
}

/** The backend serving key-maint's marker widget, if one is configured. */
export function findKeyMaintBackend(
  backends: BackendConfig[],
  widgets: WidgetDef[]
): BackendConfig | null {
  const id = widgets.find((w) => w.id === "provider_api_keys")?.backendId;
  return backends.find((b) => b.id === id) ?? null;
}

/**
 * Only a "Missing credential" body proves the key is absent. Every other
 * failure (auth on the API itself, timeouts, validation) says nothing about
 * the key, so it must stay unknown rather than turn the badge red.
 */
export function classifyProbeError(e: unknown): ProviderKeyStatus {
  const msg = e instanceof Error ? e.message : String(e);
  return /missing credential/i.test(msg) ? "unkeyed" : "unknown";
}

/** The widget's own declared defaults, ready to send as query params. */
export function defaultParamValues(widget: WidgetDef): ParamValues {
  const out: ParamValues = {};
  for (const p of widget.params) {
    if (p.value !== null && p.value !== undefined && p.value !== "") {
      out[p.paramName] = p.value;
    }
  }
  return out;
}

function defaultlessParamCount(widget: WidgetDef): number {
  return widget.params.filter(
    (p) => p.value === null || p.value === undefined || p.value === ""
  ).length;
}

/**
 * The probe widget for a provider: one of that provider's OWN widgets (so
 * the endpoint certainly accepts the provider), preferring the one with the
 * fewest params lacking defaults. Only "table", "chart", and "metric"
 * widgets are eligible — every other type (iframe, live_grid, html,
 * markdown, pdf, multi_file_viewer, ...) returns a body that isn't JSON, so
 * `res.json()` would throw and the probe would be misclassified as
 * "unknown" instead of skipped outright.
 *
 * If every candidate still has at least one param lacking a default, none of
 * them can be probed without guessing a value — sending the request anyway
 * fires a request known to fail validation (422), which is worse than not
 * probing at all. In that case there is no usable probe widget: null.
 */
export function pickProbeWidget(widgets: WidgetDef[], normProvider: string): WidgetDef | null {
  const candidates = widgets.filter(
    (w) =>
      (w.type === "table" || w.type === "chart" || w.type === "metric") &&
      w.source.some((s) => normalizeProvider(s) === normProvider)
  );
  if (candidates.length === 0) return null;
  const best = candidates.reduce((best, w) =>
    defaultlessParamCount(w) < defaultlessParamCount(best) ? w : best
  );
  return defaultlessParamCount(best) === 0 ? best : null;
}

/** Distinct provider display names across the widget set, sorted. */
export function widgetProviders(widgets: WidgetDef[]): string[] {
  return [...new Set(widgets.flatMap((w) => w.source))].sort();
}
