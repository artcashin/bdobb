/** @jsxImportSource react */

import { fireEvent, render, screen } from "@testing-library/react";
import AppShell from "./AppShell";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";

beforeEach(() => {
  useDashboardStore.setState({ dashboards: [], activeId: null });
  useRegistryStore.setState({ widgets: [] });
});

function shell(): HTMLElement {
  const element = document.querySelector(".app-shell") as HTMLElement;
  if (!element) {
    throw new Error("Element .app-shell not found");
  }
  return element;
}

describe("AppShell", () => {
  it("renders the left rail and the dashboard area", () => {
    render(<AppShell />);
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
    expect(shell().querySelector(".main-area")).toBeInTheDocument();
  });

  it("toggles the widget library panel from the rail", () => {
    render(<AppShell />);
    expect(document.querySelector(".library-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /widget library/i }));
    expect(document.querySelector(".library-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /widget library/i }));
    expect(document.querySelector(".library-panel")).not.toBeInTheDocument();
  });

  it("built-in widgets are offered before any backend is configured", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: /widget library/i }));
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("Clock")).toBeInTheDocument();
  });

  it("opens the backends dialog from the rail", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: /backends/i }));
    expect(screen.getByRole("dialog", { name: /backends/i })).toBeInTheDocument();
  });

  it("opens the settings dialog from the rail", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("dialog", { name: /settings/i })).toBeInTheDocument();
  });
});
