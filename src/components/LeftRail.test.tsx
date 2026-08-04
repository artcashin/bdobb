import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LeftRail from "./LeftRail";
import { useDashboardStore } from "../stores/dashboardStore";

beforeEach(() => {
  useDashboardStore.setState({
    dashboards: [
      { id: "d1", name: "Main", cards: [] },
      { id: "d2", name: "Macro", cards: [] },
    ],
    activeId: "d1",
  });
});

function renderRail() {
  const onOpenLibrary = vi.fn();
  const onOpenBackends = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <LeftRail
      onOpenLibrary={onOpenLibrary}
      onOpenBackends={onOpenBackends}
      onOpenSettings={onOpenSettings}
    />
  );
  return { onOpenLibrary, onOpenBackends, onOpenSettings };
}

describe("LeftRail", () => {
  it("exposes an accessible name for every icon-only button", () => {
    renderRail();
    expect(screen.getByRole("button", { name: "Widget Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backends" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("does not render the non-interactive Dashboards header as a button", () => {
    renderRail();
    fireEvent.mouseEnter(screen.getByRole("navigation", { name: "Navigation rail" }));
    expect(screen.queryByRole("button", { name: "Dashboards" })).not.toBeInTheDocument();
    expect(screen.getByText("Dashboards")).toBeInTheDocument();
  });

  it("calls the corresponding handler when a rail button is clicked", () => {
    const { onOpenLibrary, onOpenBackends, onOpenSettings } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Widget Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
    expect(onOpenBackends).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("does not render the dashboard list while collapsed", () => {
    renderRail();
    expect(screen.queryByText("Main")).not.toBeInTheDocument();
    expect(screen.queryByText("Macro")).not.toBeInTheDocument();
  });

  it("lists dashboards while expanded and calls setActive on click", () => {
    renderRail();
    fireEvent.mouseEnter(screen.getByRole("navigation", { name: "Navigation rail" }));
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("Macro")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Macro"));
    expect(useDashboardStore.getState().activeId).toBe("d2");
  });
});
