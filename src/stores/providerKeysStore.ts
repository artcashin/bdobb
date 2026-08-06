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

/**
 * The in-flight probe wave's abort controller, if any. A new refresh() call
 * aborts whatever wave is still running before starting its own -- without
 * this, three quick backend edits fan out three overlapping waves (up to 12
 * concurrent live requests, since "capped at 4" is only ever per-wave).
 */
let activeProbeAbort: AbortController | null = null;

export const useProviderKeysStore = create<ProviderKeysState>((set, get) => ({
  status: {},
  source: "none",

  async refresh(backends, widgets, deps = {}) {
    const token = ++refreshToken;
    activeProbeAbort?.abort();
    const abortController = new AbortController();
    activeProbeAbort = abortController;
    const fj = deps.fetchJsonImpl ?? fetchJson;
    const fwd = deps.fetchWidgetDataImpl ?? fetchWidgetData;

    const km = findKeyMaintBackend(backends, widgets);
    if (km) {
      try {
        const url = resolveEndpoint(km.baseUrl, "keys").toString();
        const json = (await fj(url, km)) as { rows?: unknown };
        if (token !== refreshToken) return;
        // A 200 with no rows array (an error body, a tier-gated response, a
        // proxy page) is not "zero rows" -- treating it that way would badge
        // every provider "keyed" via the unlisted-provider default below.
        // Fall through to the same catch path as a hard fetch failure.
        if (!Array.isArray(json.rows)) {
          throw new Error("key-maint /keys response missing a rows array");
        }
        set({ status: parseKeyMaintRows(json.rows as KeyMaintRow[]), source: "key-maint" });
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

    const queue = [...providers];
    const probeOne = async (p: string): Promise<ProviderKeyStatus> => {
      const w = pickProbeWidget(widgets, p);
      const backend = w ? backends.find((b) => b.id === w.backendId) : undefined;
      if (!w || !backend) return "unknown";
      try {
        await fwd(backend, w, defaultParamValues(w), {}, undefined, abortController.signal);
        return "keyed";
      } catch (e) {
        return classifyProbeError(e);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
        for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
          if (token !== refreshToken) return;
          const result = await probeOne(p);
          if (token !== refreshToken) return;
          // Committed one provider at a time, not after the whole Promise.all
          // settles: a single hung backend must not gate every other badge
          // that already has an answer.
          set((state) => ({ status: { ...state.status, [p]: result }, source: "probe" }));
        }
      })
    );
  },

  statusFor(providerName) {
    const { status, source } = get();
    const norm = normalizeProvider(providerName);
    if (norm in status) return status[norm];
    return source === "key-maint" ? "keyed" : "unknown";
  },
}));
