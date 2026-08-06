import { useEffect, useState } from "react";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { useBackendsStore } from "./stores/backendsStore";
import { useDashboardStore } from "./stores/dashboardStore";
import { useChatStore } from "./stores/chatStore";
import { useRegistryStore } from "./stores/registryStore";
import { useProviderKeysStore } from "./stores/providerKeysStore";
import { useSettingsStore } from "./stores/settingsStore";
import { logError } from "./lib/logger";

export default function App() {
  // Finding 3 (desk dc4664b): a startup failure used to be logged only --
  // the user saw nothing but a quietly empty dashboard/backend list. Each
  // store still loads independently below (one failing can't starve the
  // others), but the failing ones are now also named in a banner AppShell
  // renders, not just the log.
  const [startupErrors, setStartupErrors] = useState<string[]>([]);

  useEffect(() => {
    // Each store loads on its own. These were awaited in one chain inside a
    // single try, so one unreadable file — a corrupt settings.json, say —
    // aborted every loader after it and the app came up with no backends, no
    // dashboards and no chat history, none of which had anything wrong.
    const load = (label: string, run: () => Promise<unknown>) =>
      run().catch((e) => {
        logError(`startup: ${label} failed: ${String(e)}`);
        setStartupErrors((prev) => [...prev, label]);
      });

    void load("settings", () => useSettingsStore.getState().load());
    void load("dashboards", () => useDashboardStore.getState().load());
    void load("chat", () => useChatStore.getState().load());

    // Widget discovery is the one genuine ordering dependency: it needs the
    // backends it is about to query. Still never blocks launch on the
    // network -- and unlike the loads above, a refresh failure doesn't get
    // its own banner entry: it's a best-effort background refresh, not a
    // store the rest of the app depends on being loaded.
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
  }, []);

  // Last-resort boundary. Per-card and per-pane boundaries should catch a
  // render failure first; this one keeps a crash outside them from leaving a
  // blank window with no indication of what happened.
  return (
    <ErrorBoundary label="Application">
      <AppShell startupErrors={startupErrors} />
    </ErrorBoundary>
  );
}
