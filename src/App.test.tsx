import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { useProviderKeysStore } from "./stores/providerKeysStore";
import { useSettingsStore } from "./stores/settingsStore";
import * as logger from "./lib/logger";

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
    // settings.json aborted backends, dashboards and chat as well — three
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

// Finding 3 (desk dc4664b): a startup failure used to be logged only -- the
// user saw nothing but a quietly empty dashboard/backend list. AppShell now
// renders a banner naming whichever startup steps actually failed.
describe("startup error banner (Finding 3)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names a failed startup step in a visible banner", async () => {
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

    const banner = container.querySelector(".startup-error-banner");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("settings");

    act(() => root.unmount());
    container.remove();
    settingsLoad.mockRestore();
  });

  it("renders no banner when every startup load succeeds", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    expect(container.querySelector(".startup-error-banner")).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});

// Finding 6: the startup chain's single .catch labeled every failure in it
// "registry refresh failed", even a providerKeys.refresh() failure that came
// after the registry refresh had already succeeded.
describe("startup refresh failure labeling (Finding 6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("labels a provider-keys refresh failure accurately, not as a registry failure", async () => {
    const logErrorSpy = vi.spyOn(logger, "logError");
    vi.spyOn(useProviderKeysStore.getState(), "refresh").mockRejectedValue(
      new Error("boom")
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("provider keys refresh failed")
    );
    expect(logErrorSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/registry refresh failed.*boom/)
    );

    act(() => root.unmount());
    container.remove();
  });

  it("still labels a registry refresh failure as a registry failure", async () => {
    const logErrorSpy = vi.spyOn(logger, "logError");
    vi.spyOn(useRegistryStore.getState(), "refresh").mockRejectedValue(
      new Error("registry boom")
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    let root: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(App));
    });
    await settle();

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("registry refresh failed")
    );

    act(() => root.unmount());
    container.remove();
  });
});
