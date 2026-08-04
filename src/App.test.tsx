import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files, resetFs, BaseDirectory, exists, mkdir, readDir, readTextFile, remove, rename, stat, writeTextFile } from "./test/memfs";

vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
}));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async () => {
    throw new Error("no network in tests");
  }),
}));

import App from "./App";
import { useBackendsStore } from "./stores/backendsStore";
import { useDashboardStore } from "./stores/dashboardStore";
import { useRegistryStore } from "./stores/registryStore";
import { useSettingsStore } from "./stores/settingsStore";

function dashboardFileCount(): number {
  return [...files.keys()].filter(
    (k) => k.startsWith("dashboards/") && k.endsWith(".json")
  ).length;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  resetFs();
  useSettingsStore.setState({ settings: undefined });
  useBackendsStore.setState({ backends: [] });
  useDashboardStore.setState({ dashboards: [], activeId: null });
  useRegistryStore.setState({ widgets: [] });
});

describe("App startup bootstrap", () => {
  it("seeds exactly one dashboard file on a normal (non-Strict) mount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    expect(dashboardFileCount()).toBe(1);

    act(() => root.unmount());
    container.remove();
  });

  it("seeds exactly one dashboard file when StrictMode double-invokes the mount effect", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(App))
      );
    });
    await settle();

    const dashboardFiles = [...files.keys()].filter(
      (k) => k.startsWith("dashboards/") && k.endsWith(".json")
    );
    expect(dashboardFiles).toHaveLength(1);
    expect(useDashboardStore.getState().dashboards).toHaveLength(1);

    act(() => root.unmount());
    container.remove();
  });

  it("still loads the other stores when one loader throws", async () => {
    // The loaders were awaited in a single chain inside one try, so a corrupt
    // settings.json aborted backends and dashboards as well — several
    // subsystems lost to one unrelated failure.
    const settingsLoad = vi
      .spyOn(useSettingsStore.getState(), "load")
      .mockRejectedValue(new Error("settings.json is corrupt"));

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    expect(settingsLoad).toHaveBeenCalled();
    // Dashboards loaded despite settings failing, and seeded as usual.
    expect(dashboardFileCount()).toBe(1);
    expect(useDashboardStore.getState().dashboards).toHaveLength(1);

    act(() => root.unmount());
    container.remove();
    settingsLoad.mockRestore();
  });
});
