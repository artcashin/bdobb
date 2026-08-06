import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
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
