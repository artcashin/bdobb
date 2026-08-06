import { create } from "zustand";
import type { BackendConfig, WidgetDef } from "../lib/types";
import { fetchJson, fetchWidgetData, resolveEndpoint } from "../lib/dataClient";
import {
  classifyProbeError,
  defaultParamValues,
  findKeyMaintBackend,
  normalizeProvider,
  parseKeyMaintRows,
  pickProbeWidget,
  widgetProviders,
  type KeyMaintRow,
  type ProviderKeyStatus,
} from "../lib/providerKeys";
import { logError } from "../lib/logger";

export type ProviderKeySource = "key-maint" | "probe" | "none";

interface ProviderKeysDeps {
  fetchJsonImpl?: typeof fetchJson;
  fetchWidgetDataImpl?: typeof fetchWidgetData;
}

interface ProviderKeysState {
  /** normalized provider -> status; empty until the first refresh lands */
  status: Record<string, ProviderKeyStatus>;
  source: ProviderKeySource;
  refresh(
    backends: BackendConfig[],
    widgets: WidgetDef[],
    deps?: ProviderKeysDeps
  ): Promise<void>;
  /**
   * Lookup by display name ("Eodhd", "Alpha_vantage"). Key-maint only lists
   * providers that TAKE a key, so with that source an unlisted provider is
   * keyless and works — keyed. Probe mode carries no such implication, so
   * anything it didn't (or couldn't) probe stays unknown.
   */
  statusFor(providerName: string): ProviderKeyStatus;
}

const PROBE_CONCURRENCY = 4;

/** Discards a stale refresh: only the latest call may write the store. */
let refreshToken = 0;

export const useProviderKeysStore = create<ProviderKeysState>((set, get) => ({
  status: {},
  source: "none",

  async refresh(backends, widgets, deps = {}) {
    const token = ++refreshToken;
    const fj = deps.fetchJsonImpl ?? fetchJson;
    const fwd = deps.fetchWidgetDataImpl ?? fetchWidgetData;

    const km = findKeyMaintBackend(backends, widgets);
    if (km) {
      try {
        const url = resolveEndpoint(km.baseUrl, "keys").toString();
        const json = (await fj(url, km)) as { rows?: KeyMaintRow[] };
        if (token !== refreshToken) return;
        set({ status: parseKeyMaintRows(json.rows ?? []), source: "key-maint" });
        return;
      } catch (e) {
        // A dead key-maint should not blank the feature: fall through to
        // probing, which needs nothing beyond the widgets themselves.
        logError(`providerKeys: key-maint /keys failed, probing instead: ${String(e)}`);
      }
    }

    const providers = [...new Set(widgetProviders(widgets).map(normalizeProvider))].filter(
      Boolean
    );
    if (providers.length === 0 || backends.length === 0) {
      if (token === refreshToken) set({ status: {}, source: "none" });
      return;
    }

    const results: Record<string, ProviderKeyStatus> = {};
    const queue = [...providers];
    const probeOne = async (p: string): Promise<ProviderKeyStatus> => {
      const w = pickProbeWidget(widgets, p);
      const backend = w ? backends.find((b) => b.id === w.backendId) : undefined;
      if (!w || !backend) return "unknown";
      try {
        await fwd(backend, w, defaultParamValues(w));
        return "keyed";
      } catch (e) {
        return classifyProbeError(e);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          results[p] = await probeOne(p);
        }
      })
    );
    if (token !== refreshToken) return;
    set({ status: results, source: "probe" });
  },

  statusFor(providerName) {
    const { status, source } = get();
    const norm = normalizeProvider(providerName);
    if (norm in status) return status[norm];
    return source === "key-maint" ? "keyed" : "unknown";
  },
}));
