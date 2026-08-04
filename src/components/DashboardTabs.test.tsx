import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockImport = vi.hoisted(() => vi.fn());
const mockExport = vi.hoisted(() => vi.fn());
vi.mock("../lib/appsJsonFile", () => ({
  importAppsJson: mockImport,
  exportAppsJson: mockExport,
}));
vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

import DashboardTabs from "./DashboardTabs";
import { useDashboardStore } from "../stores/dashboardStore";
import { useRegistryStore } from "../stores/registryStore";

describe("DashboardTabs", () => {
  it("renders tabs and switches the active dashboard on click", () => {
    useDashboardStore.setState({
      dashboards: [
        { id: "d1", name: "Main", cards: [] },
        { id: "d2", name: "Macro", cards: [] },
      ],
      activeId: "d1",
    });
    render(<DashboardTabs />);
    expect(screen.getByText("Main")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Macro"));
    expect(useDashboardStore.getState().activeId).toBe("d2");
  });

  it("marks the add-dashboard glyph decorative, consistent with the other icon buttons", () => {
    useDashboardStore.setState({
      dashboards: [{ id: "d1", name: "Main", cards: [] }],
      activeId: "d1",
    });
    render(<DashboardTabs />);
    const addButton = screen.getByRole("button", { name: "New dashboard" });
    const glyph = addButton.querySelector("span");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveTextContent("+");
  });

  // Finding 2 (desk dc4664b): every dashboard mutation is optimistic (state
  // updates before the disk write is even attempted) and every consumer's
  // failure handling was `.catch(logError)` only -- a write could fail (full
  // disk, revoked permissions, read-only $APPDATA) with literally nothing on
  // screen. dashboardStore (Task 11) tracks the most recent write's outcome
  // in `saveError`; this is where it has to actually become visible.
  describe("saveError banner (Finding 2)", () => {
    beforeEach(() => {
      useDashboardStore.setState({
        dashboards: [{ id: "d1", name: "Main", cards: [] }],
        activeId: "d1",
        saveError: null,
      });
    });

    it("renders nothing when there is no save error", () => {
      render(<DashboardTabs />);
      expect(document.querySelector(".save-error-banner")).not.toBeInTheDocument();
    });

    it("renders a visible banner naming the failure when saveError is set", () => {
      useDashboardStore.setState({ saveError: "Failed to save: disk full" });
      render(<DashboardTabs />);
      const banner = document.querySelector(".save-error-banner");
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent("Failed to save: disk full");
    });

    it("dismissing the banner clears saveError without touching dashboard state", () => {
      useDashboardStore.setState({ saveError: "Failed to save: disk full" });
      render(<DashboardTabs />);
      fireEvent.click(screen.getByRole("button", { name: /dismiss save error/i }));
      expect(useDashboardStore.getState().saveError).toBeNull();
      expect(useDashboardStore.getState().dashboards).toHaveLength(1);
    });
  });
});

describe("DashboardTabs apps.json interchange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDashboardStore.setState({
      dashboards: [{ id: "d1", name: "Main", cards: [] }],
      activeId: "d1",
    });
    useRegistryStore.setState({ widgets: [] });
  });

  it("appends imported dashboards rather than replacing what exists", async () => {
    mockImport.mockResolvedValue({
      dashboards: [{ id: "i1", name: "Imported", cards: [] }],
      unresolved: [],
      warnings: [],
    });

    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Import"));

    await waitFor(() =>
      expect(useDashboardStore.getState().dashboards.map((d) => d.name)).toEqual([
        "Main",
        "Imported",
      ])
    );
    // And switches to what was just imported, so it is visible.
    expect(useDashboardStore.getState().activeId).toBe("i1");
  });

  it("tells the user which widgets were skipped", async () => {
    // An import that silently drops half a dashboard reads as the app losing
    // data; the unresolved ids have to reach the screen.
    mockImport.mockResolvedValue({
      dashboards: [{ id: "i1", name: "Imported", cards: [] }],
      unresolved: [
        { dashboard: "Imported", widgetId: "missing_widget" },
        { dashboard: "Imported", widgetId: "other_widget" },
      ],
      warnings: ["Parameter groups were dropped."],
    });

    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Import"));

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("2 widget(s) skipped");
    expect(notice).toHaveTextContent("missing_widget");
    expect(notice).toHaveTextContent("Parameter groups were dropped.");
  });

  it("says nothing and changes nothing when the dialog is cancelled", async () => {
    mockImport.mockResolvedValue(null);
    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Import"));

    await waitFor(() => expect(mockImport).toHaveBeenCalled());
    expect(useDashboardStore.getState().dashboards).toHaveLength(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("surfaces a read failure instead of failing silently", async () => {
    mockImport.mockRejectedValue(new Error("not valid JSON"));
    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Import"));

    expect(await screen.findByRole("status")).toHaveTextContent("not valid JSON");
  });

  it("exports the current dashboards and reports where they went", async () => {
    mockExport.mockResolvedValue("/tmp/bdobb-apps-2026-08-01.json");
    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Export"));

    await waitFor(() => expect(mockExport).toHaveBeenCalled());
    expect(mockExport.mock.calls[0][0]).toEqual(useDashboardStore.getState().dashboards);
    expect(await screen.findByRole("status")).toHaveTextContent("bdobb-apps-2026-08-01.json");
  });
});

describe("DashboardTabs app sections", () => {
  it("brackets an imported app's tabs under its name", () => {
    // A 14-tab import used to arrive as 14 unrelated siblings; the section is
    // what makes them read as one app.
    useDashboardStore.setState({
      dashboards: [
        { id: "d1", name: "Types", appName: "Onboarding", cards: [] },
        { id: "d2", name: "Plotly", appName: "Onboarding", cards: [] },
        { id: "d3", name: "Scratch", cards: [] },
      ],
      activeId: "d1",
    });
    render(<DashboardTabs />);

    const group = screen.getByRole("group", { name: "App: Onboarding" });
    expect(group).toHaveTextContent("Types");
    expect(group).toHaveTextContent("Plotly");
    // An ungrouped dashboard stays outside it.
    expect(group).not.toHaveTextContent("Scratch");
    expect(screen.getByText("Scratch")).toBeInTheDocument();
  });

  it("keeps two apps in separate sections", () => {
    useDashboardStore.setState({
      dashboards: [
        { id: "d1", name: "A", appName: "One", cards: [] },
        { id: "d2", name: "B", appName: "Two", cards: [] },
      ],
      activeId: "d1",
    });
    render(<DashboardTabs />);
    expect(screen.getByRole("group", { name: "App: One" })).toHaveTextContent("A");
    expect(screen.getByRole("group", { name: "App: Two" })).toHaveTextContent("B");
  });

  it("still switches dashboards from inside a section", () => {
    useDashboardStore.setState({
      dashboards: [
        { id: "d1", name: "Types", appName: "Onboarding", cards: [] },
        { id: "d2", name: "Plotly", appName: "Onboarding", cards: [] },
      ],
      activeId: "d1",
    });
    render(<DashboardTabs />);
    fireEvent.click(screen.getByText("Plotly"));
    expect(useDashboardStore.getState().activeId).toBe("d2");
  });
});

