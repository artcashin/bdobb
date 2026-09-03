import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// RitaTab's module graph (RitaTab.tsx -> chatShare.ts -> symphonyPayload.ts)
// must not reach Plotly: the settings dialog never renders a chart. A mock
// that throws on import proves it -- if symphonyPayload.ts went back to a
// static `import Plotly from "plotly.js-dist-min"`, this file's very first
// import of RitaTab below would already have executed this factory (module
// evaluation is eager for a static import) and the whole file would fail
// before any test ran.
vi.mock("plotly.js-dist-min", () => {
  throw new Error(
    "plotly.js-dist-min must not be statically imported by the settings dialog's module graph"
  );
});

import RitaTab from "./RitaTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";

const baseSettings = {
  ...DEFAULT_SETTINGS,
  ritaUrl: "http://localhost:8002",
  contextSharing: true,
  shareTargets: [],
};

function renderTab(over: Partial<typeof baseSettings> = {}) {
  const onChange = vi.fn();
  render(
    <RitaTab settings={{ ...baseSettings, ...over }} onChange={onChange} fieldIds="t" />
  );
  return { onChange };
}

describe("RitaTab", () => {
  it("renders Rita URL input", () => {
    renderTab();
    expect(screen.getByDisplayValue("http://localhost:8002")).toBeInTheDocument();
    expect(screen.getByText("Rita URL")).toBeInTheDocument();
  });

  it("renders context sharing toggle", () => {
    renderTab();
    const toggle = screen.getByRole("switch");
    expect(toggle).toBeInTheDocument();
  });
});
