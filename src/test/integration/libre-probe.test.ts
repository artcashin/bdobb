// Opt-in probe: can BDOBB's client use a Libre Terminal install as a backend? Set PROBE_URL, PROBE_OUT (and optionally PROBE_ORIGIN, PROBE_FETCH).
import { describe, it, vi } from "vitest";
import { writeFileSync } from "node:fs";

const ORIGIN = process.env.PROBE_ORIGIN ?? ""; // what tauri-plugin-http would send
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (ORIGIN) headers.set("Origin", ORIGIN);
    return globalThis.fetch(url, { ...init, headers, signal: AbortSignal.timeout(25_000) });
  },
}));

import { fetchWidgetsJson, fetchWidgetData, fetchJson, buildWidgetUrl } from "../../lib/dataClient";
import { parseWidgetsJson } from "../../lib/widgets";
import { initialParamValues } from "../../lib/params";
import { appsJsonToDashboards } from "../../lib/appsJson";
import type { BackendConfig, WidgetDef } from "../../lib/types";

const RENDERED = ["table", "chart", "metric", "markdown", "html", "iframe", "pdf", "multi_file_viewer", "live_grid"];
const count = <T,>(xs: T[], key: (x: T) => string) =>
  xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

describe.skipIf(!process.env.PROBE_URL)("libre terminal probe", () => {
  it("probes", async () => {
    const backend: BackendConfig = { id: "libre", name: "Libre", baseUrl: process.env.PROBE_URL! };
    const out: Record<string, unknown> = { url: backend.baseUrl, origin: ORIGIN || "(none)" };
    let widgets: WidgetDef[] = [];
    try {
      widgets = await fetchWidgetsJson(backend);
      const raw = (await fetchJson(`${backend.baseUrl}/widgets.json`, backend)) as Record<string, unknown>;
      const kept = new Set(parseWidgetsJson(raw as never, backend.id).map((w) => w.id));
      out.rawWidgets = Object.keys(raw).length;
      out.parsed = widgets.length;
      out.dropped = Object.keys(raw).filter((id) => !kept.has(id)).slice(0, 20);
      out.types = count(widgets, (w) => w.type);
      out.unrenderedTypes = Object.keys(out.types as object).filter((t) => !RENDERED.includes(t));
    } catch (e) {
      out.discoveryError = String(e).slice(0, 300);
    }
    try {
      const apps = await fetchJson(`${backend.baseUrl}/apps.json`, backend);
      const byId = new Map(widgets.map((w) => [w.id, w]));
      const { dashboards, unresolved } = appsJsonToDashboards(apps as never, (id) => {
        const widget = byId.get(id);
        return widget ? { backendId: backend.id, widget } : null;
      });
      out.dashboards = dashboards.length;
      out.cards = dashboards.flatMap((d) => d.cards).length;
      out.unresolved = unresolved.length;
      out.unresolvedSample = unresolved.slice(0, 8).map((u) => u.widgetId);
    } catch (e) {
      out.appsError = String(e).slice(0, 300);
    }
    const limit = Number(process.env.PROBE_FETCH ?? 0);
    if (limit && widgets.length) {
      const targets = widgets.filter((w) => ["table", "metric", "chart"].includes(w.type));
      const step = Math.max(1, Math.floor(targets.length / limit));
      const sample = targets.filter((_, i) => i % step === 0).slice(0, limit);
      const results: { id: string; type: string; outcome: string; detail: string }[] = [];
      let i = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          while (i < sample.length) {
            const w = sample[i++];
            const values = initialParamValues(w);
            try {
              const data = await fetchWidgetData(backend, w, values, { theme: "dark" });
              const n = Array.isArray(data) ? `rows=${data.length}` : typeof data;
              results.push({ id: w.id, type: w.type, outcome: data == null ? "null" : "ok", detail: n });
            } catch (e) {
              const s = String(e);
              const m = /HTTP (\d+)/.exec(s);
              results.push({
                id: w.id, type: w.type, outcome: m ? `http${m[1]}` : "error",
                detail: s.slice(0, 260) + " | " + buildWidgetUrl(backend, w, values, { theme: "dark" }),
              });
            }
          }
        })
      );
      out.fetchSampled = sample.length;
      out.fetchOutcomes = count(results, (r) => r.outcome);
      out.fetchResults = results;
    }
    writeFileSync(process.env.PROBE_OUT!, JSON.stringify(out, null, 2));
  }, 900_000);
});
