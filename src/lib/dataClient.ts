import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { BackendConfig, ParamValues, WidgetDef } from "./types";
import { parseWidgetsJson } from "./widgets";
import { rethrowWithScopeHelp } from "./httpScope";

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    body: string
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export function serializeParams(values: ParamValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v.join(","); // multiSelect: comma-joined into ONE param
    } else if (typeof v === "boolean") {
      out[k] = v ? "true" : "false";
    } else {
      const s = String(v);
      if (s === "") continue;
      out[k] = s;
    }
  }
  return out;
}

export interface WidgetFetchOpts {
  raw?: boolean;
  theme?: "dark" | "light";
}

/**
 * Resolves a widgets.json endpoint against a backend's base URL.
 *
 * Not `new URL(endpoint, baseUrl)`, which gets two things wrong. A leading "/"
 * makes the endpoint host-relative, so a backend served under a path — say
 * https://host/openbb/api — loses that path and every request goes to the
 * host root. And "//other.example/x" is read as protocol-relative, retargeting
 * the request at an entirely different origin while authHeaders still attaches
 * the backend's credentials to it; widgets.json is remote input, so that is a
 * way to make the app hand its API key to a host of the document's choosing.
 *
 * Stripping the leading slashes makes the endpoint a path segment under the
 * base path, and leaves no syntax by which it can change the origin.
 *
 * Exported so callers resolving other widgets.json-declared endpoints (e.g.
 * ParamControls' `optionsEndpoint`) get the same origin-pinning instead of
 * reimplementing it with a bare `new URL(endpoint, baseUrl)`, which reopens
 * exactly the host-relative / protocol-relative holes described above.
 */
export function resolveEndpoint(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const rel = endpoint.replace(/^\/+/, "");
  return new URL(`${basePath}/${rel}`, base.origin);
}

export function buildWidgetUrl(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  opts: WidgetFetchOpts = {}
): string {
  if (widget.type === "iframe") {
    // iframe endpoints are full URLs used verbatim (no params, no theme).
    // This runs during React render, so a malformed/missing endpoint from
    // widgets.json must degrade to the raw string, not throw and white-screen
    // the whole dashboard over one bad widget.
    try {
      return new URL(widget.endpoint).toString();
    } catch {
      return widget.endpoint;
    }
  }
  const url = resolveEndpoint(backend.baseUrl, widget.endpoint);
  for (const [k, v] of Object.entries(serializeParams(values))) {
    url.searchParams.set(k, v);
  }
  if (opts.theme && (widget.type === "chart" || widget.type === "html")) {
    url.searchParams.set("theme", opts.theme);
  }
  if (opts.raw) url.searchParams.set("raw", "true");
  return url.toString();
}

export function extractData(json: unknown, dataKey: string | null): unknown {
  if (Array.isArray(json)) return json;
  if (dataKey === null) return json;
  let cur: unknown = json;
  for (const part of dataKey.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) {
      return json; // path missing -> caller falls back to raw JSON view
    }
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function authHeaders(backend?: BackendConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (backend?.headerName && backend.headerValue) {
    h[backend.headerName] = backend.headerValue;
  }
  return h;
}

async function doFetch(
  url: string,
  accept: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch,
  signal?: AbortSignal
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: accept, ...authHeaders(backend) },
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    // plugin-http rejects an out-of-scope URL before any response exists, so
    // this cannot be handled below with the status checks. Its own message is
    // accurate but says nothing about where the allowlist comes from.
    rethrowWithScopeHelp(e, url);
  }
  if (!res.ok) {
    throw new HttpError(res.status, url, await res.text().catch(() => ""));
  }
  return res;
}

export async function fetchJson(
  url: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await doFetch(url, "application/json", backend, fetchImpl, signal);
  return res.json();
}

export async function fetchText(
  url: string,
  backend?: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch,
  signal?: AbortSignal
): Promise<string> {
  const res = await doFetch(url, "text/html, text/plain, */*", backend, fetchImpl, signal);
  return res.text();
}

export async function fetchWidgetData(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  opts: WidgetFetchOpts = {},
  fetchImpl: typeof fetch = tauriFetch,
  signal?: AbortSignal
): Promise<unknown> {
  const url = buildWidgetUrl(backend, widget, values, opts);
  const json = await fetchJson(url, backend, fetchImpl, signal);
  if (opts.raw) {
    // raw view: still an OBBject envelope, not plain records. Prefer the
    // widget's own dataKey when configured; otherwise fall back to the
    // conventional "results" array, otherwise use the response as-is.
    if (widget.dataKey) return extractData(json, widget.dataKey);
    if (
      !Array.isArray(json) &&
      json !== null &&
      typeof json === "object" &&
      Array.isArray((json as Record<string, unknown>).results)
    ) {
      return (json as Record<string, unknown>).results;
    }
    return json;
  }
  return extractData(json, widget.dataKey);
}

export async function fetchWidgetHtml(
  backend: BackendConfig,
  widget: WidgetDef,
  values: ParamValues,
  fetchImpl: typeof fetch = tauriFetch,
  signal?: AbortSignal
): Promise<string> {
  const url = buildWidgetUrl(backend, widget, values, { theme: "dark" });
  return fetchText(url, backend, fetchImpl, signal);
}

export async function fetchWidgetsJson(
  backend: BackendConfig,
  fetchImpl: typeof fetch = tauriFetch
): Promise<WidgetDef[]> {
  const base = backend.baseUrl.replace(/\/+$/, "");
  const json = await fetchJson(`${base}/widgets.json`, backend, fetchImpl);
  return parseWidgetsJson(json, backend.id);
}
