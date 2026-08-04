import React from "react";
import { act } from "react";
import { vi } from "vitest";
import "@testing-library/jest-dom";

// Make React and act available globally for React 19 tests
(globalThis as unknown as { React: typeof React; act: typeof act }).React = React;
(globalThis as unknown as { act: typeof act }).act = act;

// One filesystem double, not two. This block previously reimplemented every
// plugin-fs function inline and diverged from memfs.ts in three ways: it
// ignored the `append` option (so the logger's append-only writes silently
// truncated, making rotation structurally untestable under this harness), it
// prefixed AppData paths with "openbb-desk/" (a directory production never
// uses), and remove() resolved on a missing path instead of throwing.
vi.mock("@tauri-apps/plugin-fs", () => import("./memfs"));

// jsdom doesn't implement ResizeObserver. react-grid-layout's WidthProvider
// (used by DashboardGrid) observes its container on mount, which throws
// "ResizeObserver is not defined" in any test that mounts the dashboard
// grid. This is an environment polyfill, not a mock of app code — every test that mounts the
// dashboard grid needs it, so it lives here rather than duplicated per file.
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverStub;
}

// React 19.2.8 with @testing-library/react 16.x requires window.prompt and window.confirm
if (!("prompt" in globalThis)) {
  (globalThis as unknown as { prompt: unknown }).prompt = vi.fn(() => null);
}

if (!("confirm" in globalThis)) {
  (globalThis as unknown as { confirm: unknown }).confirm = vi.fn(() => false);
}

// Guarded, not just `if (!(... in Element.prototype))`: this setup file runs
// for every test file regardless of environment (setupFiles is global, not
// per-environment), and a handful of files opt into `@vitest-environment
// node` (pure network integration suites — no DOM at all, so `Element`
// doesn't exist). Referencing it unguarded here would throw before those
// files' own tests ever run.
if (typeof Element !== "undefined") {
  // jsdom doesn't implement scrollIntoView
  if (!("scrollIntoView" in Element.prototype)) {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
  }
}

if (typeof window !== "undefined") {
  // jsdom doesn't implement URL.createObjectURL (used by plotly.js)
  if (!("createObjectURL" in window.URL)) {
    (window.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "mock-url");
  }
}
