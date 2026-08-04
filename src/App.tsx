import { useEffect } from "react";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { useBackendsStore } from "./stores/backendsStore";
import { useDashboardStore } from "./stores/dashboardStore";
import { useRegistryStore } from "./stores/registryStore";
import { useProviderKeysStore } from "./stores/providerKeysStore";
import { useSettingsStore } from "./stores/settingsStore";
import { logError } from "./lib/logger";

export default function App() {
  useEffect(() => {
    // Each store loads on its own: one unreadable file — a corrupt
    // settings.json, say — must not abort the loaders after it and bring the
    // app up with no backends and no dashboards, none of which had anything
    // wrong.
    const load = (label: string, run: () => Promise<unknown>) =>
      run().catch((e) => logError(`startup: ${label} failed: ${String(e)}`));

    void load("settings", () => useSettingsStore.getState().load());
    void load("dashboards", () => useDashboardStore.getState().load());

    // Widget discovery is the one genuine ordering dependency: it needs the
    // backends it is about to query. Still never blocks launch on the
    // network.
    void load("backends", () => useBackendsStore.getState().load()).then(() =>
      useRegistryStore
        .getState()
        .refresh(useBackendsStore.getState().backends)
        .catch((e) => logError(`startup: registry refresh failed: ${String(e)}`))
        .then(() =>
          useProviderKeysStore
            .getState()
            .refresh(useBackendsStore.getState().backends, useRegistryStore.getState().widgets)
            .catch((e) => logError(`startup: provider keys refresh failed: ${String(e)}`))
        )
    );
  }, []);

  // Last-resort boundary. Per-card boundaries should catch a render failure
  // first; this one keeps a crash outside them from leaving a blank window
  // with no indication of what happened.
  return (
    <ErrorBoundary label="Application">
      <AppShell />
    </ErrorBoundary>
  );
}
