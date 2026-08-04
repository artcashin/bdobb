import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/logger", () => ({ logError: vi.fn() }));

import DashboardTabs from "./DashboardTabs";
import { useDashboardStore } from "../stores/dashboardStore";

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
