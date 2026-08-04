# Provider Badges + Provider Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Widget Library card's provider as a green/red/gray badge (keyed / unkeyed / unknown), make the library filterable by provider with an "Only my authorized providers" toggle, and collapse the left rail when the library opens.

**Architecture:** A pure-logic module (`src/lib/providerKeys.ts`) handles name normalization, key-maint row parsing, and probe classification. A zustand store (`src/stores/providerKeysStore.ts`) fills provider→status from a detected key-maint backend's `/keys` endpoint, falling back to one capped probe request per provider. `WidgetLibrary.tsx` renders the badge and two new filters from the store; `LeftRail.tsx` closes its hover panel when opening the library.

**Tech Stack:** React 18 + zustand + vitest/@testing-library (existing patterns), `dataClient.ts` fetch helpers.

**Spec:** `docs/superpowers/specs/2026-08-06-provider-badges-design.md`

## Global Constraints

- Statuses are exactly `"keyed" | "unkeyed" | "unknown"` everywhere.
- key-maint detection marker: a backend whose widgets include id `provider_api_keys`.
- Probe classification: 2xx → keyed; error text containing `Missing credential` → unkeyed; anything else → unknown (never red on ambiguity).
- Providers not listed by key-maint are keyless → keyed.
- Alpaca-style pairing is the general rule: rows sharing a normalized provider are keyed only if **all** are `set`, unkeyed if **any** is `empty`.
- Badge colors: keyed `#4caf7d`, unkeyed `#d9695f` (dark text `#0e1116`), unknown neutral — defined with the badge CSS, not borrowed from live-grid.
- Probe concurrency cap: 4. Session cache only (no persistence).
- Tests are hermetic: no network, fetches injected/mocked.
- All commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Roll-up into v3.0.0–v9.0.0 happens AFTER main is green (Task 7), via the established re-cut procedure.

---

### Task 1: Pure logic — `providerKeys.ts`

**Files:**
- Create: `src/lib/providerKeys.ts`
- Test: `src/lib/providerKeys.test.ts`

**Interfaces:**
- Consumes: `WidgetDef`, `BackendConfig`, `ParamValues` from `src/lib/types.ts`.
- Produces (used by Tasks 2 and 4):
  - `type ProviderKeyStatus = "keyed" | "unkeyed" | "unknown"`
  - `normalizeProvider(name: string): string`
  - `interface KeyMaintRow { provider: string; env_var?: string; status: string; demo?: boolean }`
  - `parseKeyMaintRows(rows: KeyMaintRow[]): Record<string, ProviderKeyStatus>`
  - `findKeyMaintBackend(backends: BackendConfig[], widgets: WidgetDef[]): BackendConfig | null`
  - `classifyProbeError(e: unknown): ProviderKeyStatus`
  - `defaultParamValues(widget: WidgetDef): ParamValues`
  - `pickProbeWidget(widgets: WidgetDef[], normProvider: string): WidgetDef | null`
  - `widgetProviders(widgets: WidgetDef[]): string[]` (distinct display names, sorted)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/providerKeys.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  classifyProbeError,
  defaultParamValues,
  findKeyMaintBackend,
  normalizeProvider,
  parseKeyMaintRows,
  pickProbeWidget,
  widgetProviders,
} from "./providerKeys";
import type { WidgetDef } from "./types";

/** Minimal WidgetDef factory — only the fields this module reads. */
function widget(over: Partial<WidgetDef>): WidgetDef {
  return {
    id: "w",
    name: "W",
    description: "",
    category: "Cat",
    subCategory: null,
    type: "table",
    endpoint: "/api/v1/x",
    gridData: { w: 10, h: 10 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: "results",
    columnsDefs: [],
    mcpUrl: null,
    backendId: "b1",
    ...over,
  } as WidgetDef;
}

describe("normalizeProvider", () => {
  it("folds case, separators and parentheticals", () => {
    expect(normalizeProvider("EODHD")).toBe("eodhd");
    expect(normalizeProvider("Eodhd")).toBe("eodhd");
    expect(normalizeProvider("Alpha Vantage")).toBe("alphavantage");
    expect(normalizeProvider("Alpha_vantage")).toBe("alphavantage");
    expect(normalizeProvider("Alpaca (secret)")).toBe("alpaca");
    expect(normalizeProvider("Congress.gov")).toBe("congressgov");
  });
});

describe("parseKeyMaintRows", () => {
  it("maps set/empty/unknown statuses", () => {
    const out = parseKeyMaintRows([
      { provider: "EODHD", status: "set", demo: false },
      { provider: "FMP", status: "empty" },
      { provider: "Tiingo", status: "unknown" },
    ]);
    expect(out).toEqual({ eodhd: "keyed", fmp: "unkeyed", tiingo: "unknown" });
  });

  it("demo keys count as keyed", () => {
    expect(parseKeyMaintRows([{ provider: "FMP", status: "set", demo: true }])).toEqual({
      fmp: "keyed",
    });
  });

  it("keys a paired provider only when every row is set (alpaca)", () => {
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "empty" },
      ])
    ).toEqual({ alpaca: "unkeyed" });
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "set" },
      ])
    ).toEqual({ alpaca: "keyed" });
    expect(
      parseKeyMaintRows([
        { provider: "Alpaca", status: "set" },
        { provider: "Alpaca (secret)", status: "unknown" },
      ])
    ).toEqual({ alpaca: "unknown" });
  });
});

describe("findKeyMaintBackend", () => {
  const backends = [
    { id: "api", name: "OpenBB", baseUrl: "https://api.example" },
    { id: "km", name: "Keys", baseUrl: "https://keys.example" },
  ];

  it("finds the backend whose widgets include provider_api_keys", () => {
    const widgets = [
      widget({ id: "etf_x", backendId: "api" }),
      widget({ id: "provider_api_keys", backendId: "km" }),
    ];
    expect(findKeyMaintBackend(backends, widgets)?.id).toBe("km");
  });

  it("returns null when no backend serves it", () => {
    expect(findKeyMaintBackend(backends, [widget({ id: "etf_x", backendId: "api" })])).toBeNull();
  });
});

describe("classifyProbeError", () => {
  it("reads a missing credential as unkeyed", () => {
    expect(
      classifyProbeError(new Error("HTTP 400 from x: {\"detail\":\"Missing credential 'alpaca_api_key'.\"}"))
    ).toBe("unkeyed");
  });

  it("anything else is unknown, never unkeyed", () => {
    expect(classifyProbeError(new Error("HTTP 401 from x: Not authenticated"))).toBe("unknown");
    expect(classifyProbeError(new Error("timeout"))).toBe("unknown");
    expect(classifyProbeError("weird non-error")).toBe("unknown");
  });
});

describe("defaultParamValues", () => {
  it("collects params that carry a default value", () => {
    const w = widget({
      params: [
        { paramName: "symbol", label: "Symbol", type: "text", value: "SPY" },
        { paramName: "interval", label: "Interval", type: "text", value: "1d" },
        { paramName: "start", label: "Start", type: "date", value: null },
      ] as WidgetDef["params"],
    });
    expect(defaultParamValues(w)).toEqual({ symbol: "SPY", interval: "1d" });
  });
});

describe("pickProbeWidget", () => {
  it("prefers the widget with the fewest defaultless params", () => {
    const needy = widget({
      id: "needy",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: null }] as WidgetDef["params"],
    });
    const ready = widget({
      id: "ready",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: "SPY" }] as WidgetDef["params"],
    });
    expect(pickProbeWidget([needy, ready], "eodhd")?.id).toBe("ready");
  });

  it("skips iframe and live_grid widgets", () => {
    const frame = widget({ id: "f", source: ["Eodhd"], type: "iframe" });
    expect(pickProbeWidget([frame], "eodhd")).toBeNull();
  });

  it("matches the provider by normalized name", () => {
    const w = widget({ id: "w1", source: ["Eodhd"] });
    expect(pickProbeWidget([w], "eodhd")?.id).toBe("w1");
    expect(pickProbeWidget([w], "fmp")).toBeNull();
  });
});

describe("widgetProviders", () => {
  it("returns distinct display names sorted", () => {
    const ws = [
      widget({ source: ["Eodhd"] }),
      widget({ source: ["Alpaca"] }),
      widget({ source: ["Eodhd"] }),
      widget({ source: [] }),
    ];
    expect(widgetProviders(ws)).toEqual(["Alpaca", "Eodhd"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/providerKeys.test.ts`
Expected: FAIL — `Cannot find module './providerKeys'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/providerKeys.ts`:

```typescript
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
 * fewest params lacking defaults — those get omitted from the request, and
 * a widget with all defaults present is the most likely to answer 200.
 * iframe widgets fetch foreign pages and live_grid speaks websockets, so
 * neither can serve as an HTTP probe.
 */
export function pickProbeWidget(widgets: WidgetDef[], normProvider: string): WidgetDef | null {
  const candidates = widgets.filter(
    (w) =>
      w.type !== "iframe" &&
      w.type !== "live_grid" &&
      w.source.some((s) => normalizeProvider(s) === normProvider)
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, w) =>
    defaultlessParamCount(w) < defaultlessParamCount(best) ? w : best
  );
}

/** Distinct provider display names across the widget set, sorted. */
export function widgetProviders(widgets: WidgetDef[]): string[] {
  return [...new Set(widgets.flatMap((w) => w.source))].sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/providerKeys.test.ts`
Expected: PASS (all describes green)

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no output (clean)

```bash
git add src/lib/providerKeys.ts src/lib/providerKeys.test.ts
git commit -m "feat: provider key-state logic — normalization, key-maint rows, probe classification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `providerKeysStore` + startup wiring

**Files:**
- Create: `src/stores/providerKeysStore.ts`
- Test: `src/stores/providerKeysStore.test.ts`
- Modify: `src/App.tsx:39-44` (chain a providerKeys refresh after the registry refresh)
- Modify: `src/components/dialogs/BackendsDialog.tsx:30-34` (same chain in `rediscover`)

**Interfaces:**
- Consumes (Task 1): `parseKeyMaintRows`, `findKeyMaintBackend`, `classifyProbeError`, `defaultParamValues`, `pickProbeWidget`, `normalizeProvider`, `widgetProviders`, `ProviderKeyStatus`, `KeyMaintRow`. From dataClient: `fetchJson`, `fetchWidgetData`, `resolveEndpoint`.
- Produces (used by Task 4):
  - `useProviderKeysStore` with state `{ status: Record<string, ProviderKeyStatus>; source: "key-maint" | "probe" | "none" }`
  - `refresh(backends: BackendConfig[], widgets: WidgetDef[], deps?: { fetchJsonImpl?: typeof fetchJson; fetchWidgetDataImpl?: typeof fetchWidgetData }): Promise<void>`
  - `statusFor(providerName: string): ProviderKeyStatus`

- [ ] **Step 1: Write the failing tests**

Create `src/stores/providerKeysStore.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderKeysStore } from "./providerKeysStore";
import type { WidgetDef } from "../lib/types";

function widget(over: Partial<WidgetDef>): WidgetDef {
  return {
    id: "w",
    name: "W",
    description: "",
    category: "Cat",
    subCategory: null,
    type: "table",
    endpoint: "/api/v1/x",
    gridData: { w: 10, h: 10 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params: [],
    dataKey: "results",
    columnsDefs: [],
    mcpUrl: null,
    backendId: "api",
    ...over,
  } as WidgetDef;
}

const apiBackend = { id: "api", name: "OpenBB", baseUrl: "https://api.example" };
const kmBackend = { id: "km", name: "Keys", baseUrl: "https://keys.example" };
const kmWidget = widget({ id: "provider_api_keys", backendId: "km" });

beforeEach(() => {
  useProviderKeysStore.setState({ status: {}, source: "none" });
});

describe("providerKeysStore", () => {
  it("prefers key-maint: fetches /keys with that backend and parses rows", async () => {
    const fetchJsonImpl = vi.fn(async () => ({
      tier: 2,
      rows: [
        { provider: "EODHD", status: "set", demo: false },
        { provider: "FMP", status: "empty" },
      ],
    }));
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend, kmBackend], [kmWidget, widget({ id: "e", source: ["Eodhd"] })], {
        fetchJsonImpl: fetchJsonImpl as never,
      });

    expect(fetchJsonImpl).toHaveBeenCalledWith("https://keys.example/keys", kmBackend);
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("key-maint");
    expect(s.statusFor("Eodhd")).toBe("keyed");
    expect(s.statusFor("FMP")).toBe("unkeyed");
  });

  it("treats providers key-maint does not list as keyless -> keyed", async () => {
    const fetchJsonImpl = vi.fn(async () => ({ tier: 2, rows: [] }));
    await useProviderKeysStore
      .getState()
      .refresh([kmBackend], [kmWidget], { fetchJsonImpl: fetchJsonImpl as never });
    expect(useProviderKeysStore.getState().statusFor("YFinance")).toBe("keyed");
  });

  it("falls back to probes when there is no key-maint backend", async () => {
    const eodhd = widget({
      id: "e",
      source: ["Eodhd"],
      params: [{ paramName: "symbol", label: "S", type: "text", value: "SPY" }] as WidgetDef["params"],
    });
    const alpaca = widget({ id: "a", source: ["Alpaca"] });
    const fetchWidgetDataImpl = vi.fn(async (_b, w: WidgetDef) => {
      if (w.id === "a") throw new Error('HTTP 400: {"detail":"Missing credential \'alpaca_api_key\'"}');
      return { ok: true };
    });

    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], [eodhd, alpaca], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });

    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("probe");
    expect(s.statusFor("Eodhd")).toBe("keyed");
    expect(s.statusFor("Alpaca")).toBe("unkeyed");
  });

  it("probe mode: ambiguous failures and unprobed providers stay unknown", async () => {
    const flaky = widget({ id: "f", source: ["Tiingo"] });
    const fetchWidgetDataImpl = vi.fn(async () => {
      throw new Error("HTTP 401: Not authenticated");
    });
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], [flaky], { fetchWidgetDataImpl: fetchWidgetDataImpl as never });
    expect(useProviderKeysStore.getState().statusFor("Tiingo")).toBe("unknown");
    // never probed at all -> unknown, NOT the key-maint keyless default
    expect(useProviderKeysStore.getState().statusFor("Fmp")).toBe("unknown");
  });

  it("falls back to probes when the key-maint fetch fails", async () => {
    const fetchJsonImpl = vi.fn(async () => {
      throw new Error("HTTP 502");
    });
    const eodhd = widget({ id: "e", source: ["Eodhd"] });
    const fetchWidgetDataImpl = vi.fn(async () => ({ ok: true }));
    await useProviderKeysStore
      .getState()
      .refresh([kmBackend, apiBackend], [kmWidget, eodhd], {
        fetchJsonImpl: fetchJsonImpl as never,
        fetchWidgetDataImpl: fetchWidgetDataImpl as never,
      });
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("probe");
    expect(s.statusFor("Eodhd")).toBe("keyed");
  });

  it("with no backends at all the source is none and everything unknown", async () => {
    await useProviderKeysStore.getState().refresh([], []);
    const s = useProviderKeysStore.getState();
    expect(s.source).toBe("none");
    expect(s.statusFor("Eodhd")).toBe("unknown");
  });

  it("caps probe concurrency at 4", async () => {
    let inFlight = 0;
    let peak = 0;
    const widgets = ["A", "B", "C", "D", "E", "F"].map((p, i) =>
      widget({ id: `w${i}`, source: [p] })
    );
    const fetchWidgetDataImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return {};
    });
    await useProviderKeysStore
      .getState()
      .refresh([apiBackend], widgets, { fetchWidgetDataImpl: fetchWidgetDataImpl as never });
    expect(peak).toBeLessThanOrEqual(4);
    expect(fetchWidgetDataImpl).toHaveBeenCalledTimes(6);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/stores/providerKeysStore.test.ts`
Expected: FAIL — `Cannot find module './providerKeysStore'`

- [ ] **Step 3: Write the store**

Create `src/stores/providerKeysStore.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/stores/providerKeysStore.test.ts`
Expected: PASS

- [ ] **Step 5: Wire refresh at startup and on backend changes**

In `src/App.tsx`, the startup chain currently ends with the registry refresh:

```typescript
    void load("backends", () => useBackendsStore.getState().load()).then(() =>
      useRegistryStore
        .getState()
        .refresh(useBackendsStore.getState().backends)
        .catch((e) => logError(`startup: registry refresh failed: ${String(e)}`))
    );
```

Replace with (adds the providerKeys refresh AFTER discovery, since it reads
the discovered widgets; same best-effort, never blocks launch):

```typescript
    void load("backends", () => useBackendsStore.getState().load()).then(() =>
      useRegistryStore
        .getState()
        .refresh(useBackendsStore.getState().backends)
        .then(() =>
          useProviderKeysStore
            .getState()
            .refresh(useBackendsStore.getState().backends, useRegistryStore.getState().widgets)
        )
        .catch((e) => logError(`startup: registry refresh failed: ${String(e)}`))
    );
```

Add the import at the top of `src/App.tsx` beside the other store imports:

```typescript
import { useProviderKeysStore } from "./stores/providerKeysStore";
```

In `src/components/dialogs/BackendsDialog.tsx`, `rediscover` currently reads:

```typescript
  const rediscover = () =>
    useRegistryStore
      .getState()
      .refresh(useBackendsStore.getState().backends)
      .catch(() => {});
```

Replace with:

```typescript
  const rediscover = () =>
    useRegistryStore
      .getState()
      .refresh(useBackendsStore.getState().backends)
      .then(() =>
        useProviderKeysStore
          .getState()
          .refresh(useBackendsStore.getState().backends, useRegistryStore.getState().widgets)
      )
      .catch(() => {});
```

Add the import beside the other store imports in that file:

```typescript
import { useProviderKeysStore } from "../../stores/providerKeysStore";
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test:run`
Expected: typecheck clean; all tests pass (App/BackendsDialog tests unaffected — the new refresh is fire-and-forget behind mocked stores).

- [ ] **Step 7: Commit**

```bash
git add src/stores/providerKeysStore.ts src/stores/providerKeysStore.test.ts src/App.tsx src/components/dialogs/BackendsDialog.tsx
git commit -m "feat: providerKeysStore — key-maint first, capped live probes as fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Provider badge on Widget Library cards

**Files:**
- Modify: `src/components/WidgetLibrary.tsx` (header badge; remove the `Source:` footer)
- Modify: `src/styles.css` (badge styles, after `.widget-library-widget-type` at ~line 912)
- Test: `src/components/WidgetLibrary.test.tsx`

**Interfaces:**
- Consumes (Task 2): `useProviderKeysStore` — `statusFor(providerName): "keyed" | "unkeyed" | "unknown"`.
- Produces: CSS classes `widget-library-widget-provider` with modifier `keyed | unkeyed | unknown` (Task 6's roll-up relies on these names staying stable).

- [ ] **Step 1: Write the failing tests**

In `src/components/WidgetLibrary.test.tsx`, add after the imports:

```typescript
import { useProviderKeysStore } from "../stores/providerKeysStore";
```

Add inside the top-level `describe`, using the existing `mockWidgets`:

```typescript
  describe("provider badge", () => {
    it("shows the provider with its key status as the badge class", () => {
      useProviderKeysStore.setState({
        status: { eodhd: "keyed", imf: "unkeyed" },
        source: "key-maint",
      });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      const eodhd = screen.getByText("Eodhd");
      expect(eodhd.className).toContain("widget-library-widget-provider");
      expect(eodhd.className).toContain("keyed");
      expect(screen.getByText("IMF", { selector: ".widget-library-widget-provider" }).className).toContain(
        "unkeyed"
      );
    });

    it("marks providers unknown while no source has answered", () => {
      useProviderKeysStore.setState({ status: {}, source: "none" });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      expect(screen.getByText("Eodhd").className).toContain("unknown");
    });

    it("renders no badge for a widget without a source", () => {
      useProviderKeysStore.setState({ status: {}, source: "key-maint" });
      const sourceless = [{ ...mockWidgets[0], id: "s", source: [] as string[] }];
      const { container } = render(
        <WidgetLibrary onSelectWidget={vi.fn()} widgets={sourceless} />
      );
      expect(container.querySelector(".widget-library-widget-provider")).toBeNull();
    });
  });
```

Note: `mockWidgets[1]` has `source: ["IMF"]` and its category is also "IMF",
so the badge assertions use a class selector where the bare text is ambiguous.

Also REPLACE the existing test at ~line 155, which asserts the footer this
task removes:

```typescript
  it("shows widget source", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByText("Source: Eodhd")).toBeInTheDocument();
    expect(screen.getByText("Source: IMF")).toBeInTheDocument();
    expect(screen.getByText("Source: Internal")).toBeInTheDocument();
  });
```

becomes (the badge now carries the source):

```typescript
  it("shows widget source as the provider badge", () => {
    useProviderKeysStore.setState({ status: {}, source: "none" });
    const { container } = render(
      <WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />
    );
    const badges = [...container.querySelectorAll(".widget-library-widget-provider")];
    expect(badges.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Eodhd", "IMF", "Internal"])
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: the three new tests FAIL (badge class not found); pre-existing tests still pass.

- [ ] **Step 3: Implement the badge**

In `src/components/WidgetLibrary.tsx`:

Add imports:

```typescript
import { useProviderKeysStore } from "../stores/providerKeysStore";
```

Inside the component, after the `widgets` line:

```typescript
  const statusFor = useProviderKeysStore((s) => s.statusFor);
```

Replace the card header's type span and the footer source div. The header block

```tsx
                  <span className="widget-library-widget-type">{widget.type}</span>
```

becomes

```tsx
                  <div className="widget-library-widget-badges">
                    <span className="widget-library-widget-type">{widget.type}</span>
                    {widget.source.length > 0 && (
                      <span
                        className={`widget-library-widget-provider ${statusFor(widget.source[0])}`}
                      >
                        {widget.source[0]}
                      </span>
                    )}
                  </div>
```

and the footer block

```tsx
                <div className="widget-library-widget-source">
                  {widget.source.length > 0 && (
                    <span>Source: {widget.source.join(", ")}</span>
                  )}
                </div>
```

is deleted entirely.

- [ ] **Step 4: Add the badge CSS**

In `src/styles.css`, directly after the `.widget-library-widget-type` rule
(~line 912), add — and delete the now-orphaned
`.widget-library-widget-source` rule (~line 916):

```css
.widget-library-widget-badges {
  display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
  flex: none;
}
/* Provider pill: green when this deployment holds a working key (or none is
   needed), red when the key is required and missing, neutral while unknown.
   The green/red pair is defined here rather than reused from live-grid —
   these classes roll up into snapshots that predate it. */
.widget-library-widget-provider {
  padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
  white-space: nowrap;
}
.widget-library-widget-provider.keyed { background: #4caf7d; color: #0e1116; }
.widget-library-widget-provider.unkeyed { background: #d9695f; color: #0e1116; }
.widget-library-widget-provider.unknown {
  background: var(--bg); color: var(--text-dim); border: 1px solid var(--border);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean

```bash
git add src/components/WidgetLibrary.tsx src/components/WidgetLibrary.test.tsx src/styles.css
git commit -m "feat: provider badge on Widget Library cards — green keyed, red unkeyed

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Provider filter + "Only my authorized providers"

**Files:**
- Modify: `src/components/WidgetLibrary.tsx`
- Modify: `src/styles.css` (filter row styles, next to `.widget-library-categories` ~line 851)
- Test: `src/components/WidgetLibrary.test.tsx`

**Interfaces:**
- Consumes: Task 2's `statusFor`; Task 1's `widgetProviders`.
- Produces: nothing consumed later — terminal UI.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/WidgetLibrary.test.tsx` inside the top-level describe:

```typescript
  describe("provider filtering", () => {
    it("narrows the grid to the selected provider", () => {
      useProviderKeysStore.setState({ status: {}, source: "key-maint" });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      fireEvent.change(screen.getByLabelText("Filter by provider"), {
        target: { value: "Eodhd" },
      });
      expect(screen.getByText("Historical Prices")).toBeInTheDocument();
      expect(screen.queryByText("IMF Data")).not.toBeInTheDocument();
    });

    it("authorized-only keeps keyed and keyless, drops unkeyed and unknown", () => {
      useProviderKeysStore.setState({
        status: { eodhd: "keyed", imf: "unkeyed" },
        source: "key-maint",
      });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      fireEvent.click(screen.getByRole("button", { name: "Only my authorized providers" }));
      expect(screen.getByText("Historical Prices")).toBeInTheDocument(); // keyed
      expect(screen.queryByText("IMF Data")).not.toBeInTheDocument(); // unkeyed
      expect(screen.getByText("Portfolio")).toBeInTheDocument(); // "Internal", unlisted -> keyless
    });

    it("authorized-only keeps sourceless widgets", () => {
      useProviderKeysStore.setState({ status: {}, source: "key-maint" });
      const sourceless = [{ ...mockWidgets[0], id: "s", name: "Builtin-ish", source: [] as string[] }];
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={sourceless} />);
      fireEvent.click(screen.getByRole("button", { name: "Only my authorized providers" }));
      expect(screen.getByText("Builtin-ish")).toBeInTheDocument();
    });

    it("provider filter composes with the category chips", () => {
      useProviderKeysStore.setState({ status: {}, source: "key-maint" });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      fireEvent.change(screen.getByLabelText("Filter by provider"), {
        target: { value: "Eodhd" },
      });
      fireEvent.click(screen.getByText("IMF", { selector: ".widget-library-category-btn" }));
      expect(screen.queryByText("Historical Prices")).not.toBeInTheDocument();
      expect(screen.queryByText("IMF Data")).not.toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: new tests FAIL — no element labeled "Filter by provider".

- [ ] **Step 3: Implement the filters**

In `src/components/WidgetLibrary.tsx`:

Add import (top, beside the other lib imports):

```typescript
import { widgetProviders } from "../lib/providerKeys";
```

Add state beside the existing filter state:

```typescript
  const [selectedProvider, setSelectedProvider] = useState<string>("All");
  const [authorizedOnly, setAuthorizedOnly] = useState(false);

  const providers = widgetProviders(widgets);
```

Extend the filter body — `filteredWidgets` becomes:

```typescript
  const filteredWidgets = widgets.filter((widget) => {
    const q = searchTerm.trim().toLowerCase();
    const haystack = `${widget.name} ${widget.description} ${widget.category} ${
      widget.subCategory ?? ""
    }`.toLowerCase();
    const matchesSearch = q === "" || haystack.includes(q);
    const matchesCategory =
      selectedCategory === "All" || widget.category === selectedCategory;
    const matchesProvider =
      selectedProvider === "All" || widget.source.includes(selectedProvider);
    // Sourceless widgets (builtins, key-maint itself) have no provider to be
    // unauthorized FOR — the toggle never hides them.
    const matchesAuthorized =
      !authorizedOnly ||
      widget.source.length === 0 ||
      widget.source.some((s) => statusFor(s) === "keyed");
    return matchesSearch && matchesCategory && matchesProvider && matchesAuthorized;
  });
```

Add the filter row to the header, directly after the
`.widget-library-categories` div:

```tsx
        <div className="widget-library-provider-filter">
          <select
            aria-label="Filter by provider"
            value={selectedProvider}
            onChange={(e) => setSelectedProvider(e.target.value)}
            className="widget-library-provider-select"
          >
            <option value="All">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-pressed={authorizedOnly}
            onClick={() => setAuthorizedOnly((v) => !v)}
            className={`widget-library-category-btn ${authorizedOnly ? "widget-library-category-btn-active" : ""}`}
          >
            Only my authorized providers
          </button>
        </div>
```

- [ ] **Step 4: Add the filter CSS**

In `src/styles.css`, after the `.widget-library-categories` block (~line 853):

```css
.widget-library-provider-filter {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
}
.widget-library-provider-select {
  font-size: 11px; padding: 3px 6px; max-width: 200px;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/components/WidgetLibrary.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean

```bash
git add src/components/WidgetLibrary.tsx src/components/WidgetLibrary.test.tsx src/styles.css
git commit -m "feat: filter the Widget Library by provider, with an authorized-only toggle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Rail collapses when the Widget Library opens

**Files:**
- Modify: `src/components/LeftRail.tsx:45-53`
- Test: `src/components/LeftRail.test.tsx`

**Interfaces:**
- Consumes: `useHoverPanel`'s existing `close(): void`.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing test**

Add to `src/components/LeftRail.test.tsx` inside the existing describe (the
file's `renderRail` helper and imports are already in place):

```typescript
  it("collapses the rail when Widget Library is opened", () => {
    const { onOpenLibrary } = renderRail();
    const rail = screen.getByLabelText("Navigation rail");
    // Expand via hover, as a pointer user would.
    fireEvent.mouseEnter(rail);
    expect(rail.className).toContain("expanded");
    fireEvent.click(screen.getByLabelText("Widget Library"));
    expect(onOpenLibrary).toHaveBeenCalled();
    expect(rail.className).not.toContain("expanded");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/LeftRail.test.tsx`
Expected: the new test FAILS on the last assertion (rail still `expanded`);
existing tests pass. If `mouseEnter` alone does not expand in the existing
tests' setup, mirror however the existing expansion test triggers it — but do
not change the assertion structure.

- [ ] **Step 3: Implement**

In `src/components/LeftRail.tsx`, the Widget Library button's handler

```tsx
          onClick={onOpenLibrary}
```

becomes

```tsx
          onClick={() => {
            // The expanded rail (z-index 40) otherwise stays painted over the
            // library overlay (z-index 30) — indefinitely on touch, where no
            // mouse-leave ever schedules the collapse.
            panel.close();
            onOpenLibrary();
          }}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/LeftRail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/LeftRail.tsx src/components/LeftRail.test.tsx
git commit -m "fix: collapse the left rail when the Widget Library opens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification on main

**Files:** none new — verification gate.

- [ ] **Step 1: Full suite, typecheck, build, capability check**

Run: `pnpm typecheck && pnpm test:run && pnpm build && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: all clean/green (this mirrors CI including the build-tree check).

- [ ] **Step 2: Visual sanity in the running app**

Run `pnpm tauri dev` (or ask Art to): open the Widget Library from the rail —
the rail folds; cards show provider pills (EODHD green given the NAS key-maint,
Alpaca red); the provider select and authorized-only toggle narrow the grid.

- [ ] **Step 3: Push and watch CI**

```bash
git push origin main
gh run watch --exit-status "$(gh run list --workflow=ci.yml --branch=main --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: CI success.

---

### Task 7: Roll up into v3.0.0–v9.0.0

**Files:** none on main — re-cut procedure (established 2026-08-06; see the
memory notes and `docs/superpowers/specs/2026-08-06-provider-badges-design.md` §Roll-up).

- [ ] **Step 1: Cherry-pick the feature commits onto each tag in a worktree**

For each tag `vN.0.0` (v3…v8; v9's tree is main's tip when main has no
post-feature commits, else treat v9 like the rest):

```bash
git -C ~/Developer/bdobb worktree add "$SCRATCH/wt-vN" "vN.0.0^{commit}"
cd "$SCRATCH/wt-vN"
git cherry-pick -n <task1..task5 commit range>
```

Expected adaptations per snapshot (same shapes as the open-scope roll-up):
- v3–v7: no `NewsRailRenderer`; v3–v5: no `chatShare`/`agent/mcp` — those
  files aren't touched by this feature, so conflicts should be limited to
  context drift in `WidgetLibrary.tsx`, `App.tsx`, `BackendsDialog.tsx`,
  `styles.css`. Resolve keeping the snapshot's surrounding code and this
  feature's additions.
- v3–v4 `BackendsDialog.tsx` predates `rediscover`-with-then chains — apply
  the equivalent minimal chain to whatever refresh call exists there.

- [ ] **Step 2: Per snapshot — install, typecheck, full suite**

```bash
pnpm install --prefer-offline && pnpm typecheck && pnpm test:run
```

Expected: green before the snapshot is sealed. Then `git add -A && git write-tree`.

- [ ] **Step 3: Rebuild the chain, re-tag, push, dispatch**

`commit-tree` replay off the scaffold preserving each snapshot's
message/author/committer/dates (script pattern in scratchpad `recut.py` /
`recut2-map.txt` from 2026-08-06); re-tag with the verbatim tag messages
(v3/v8/v9 "Companion code for Adventures in OpenBB, Ep. N", v4–v7 just
"Ep. N"); verify v9-tree == main-tree and inter-tag diff invariance; then:

```bash
git push -f origin v3.0.0 v4.0.0 v5.0.0 v6.0.0 v7.0.0 v8.0.0 v9.0.0
for t in v3.0.0 v4.0.0 v5.0.0 v6.0.0 v7.0.0 v8.0.0 v9.0.0; do
  gh workflow run release.yml --ref "$t"   # >3 tags in one push fire NO events
done
```

- [ ] **Step 4: Update the episode-repos-state memory with the new chain SHAs**
