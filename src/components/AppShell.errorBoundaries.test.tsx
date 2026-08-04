import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Finding 4 (desk dc4664b): AppShell used to render WidgetLibrary,
// BackendsDialog, SettingsDialog and ChatPane completely unwrapped -- WidgetCard
// was the ONLY place ErrorBoundary was used anywhere in the app. A throw in
// any of these four (e.g. sse.ts's malformed status update reaching
// ChatMessages, or a corrupt settings.json surviving validation into
// SettingsDialog's render) took the whole React tree down, not just that
// panel. Each mock below throws only when its flag is set, so each test
// exercises exactly one panel's boundary while leaving the others real.
//
// Adapted from desk's copy: this tree's BackendsDialog/SettingsDialog take
// an `isOpen` prop and stay mounted the whole time (Modal itself decides
// whether to render, Task 18) rather than being conditionally mounted by
// AppShell -- so for those two the mock throws on AppShell's very first
// render, before any click. The click calls are kept anyway (they exercise
// that toggling `isOpen` on an already-crashed boundary doesn't itself
// throw), and the assertions -- crash contained to `.error-box`, the rest of
// the shell still alive -- hold either way.
const throwFlags = vi.hoisted(() => ({
  widgetLibrary: false,
  backendsDialog: false,
  settingsDialog: false,
  chatPane: false,
}));

vi.mock("./WidgetLibrary", () => ({
  default: () => {
    if (throwFlags.widgetLibrary) throw new Error("widget library boom");
    return <div data-testid="widget-library-ok">lib ok</div>;
  },
}));
vi.mock("./dialogs/BackendsDialog", () => ({
  default: () => {
    if (throwFlags.backendsDialog) throw new Error("backends dialog boom");
    return <div data-testid="backends-dialog-ok">backends ok</div>;
  },
}));
vi.mock("./dialogs/SettingsDialog", () => ({
  default: () => {
    if (throwFlags.settingsDialog) throw new Error("settings dialog boom");
    return <div data-testid="settings-dialog-ok">settings ok</div>;
  },
}));
vi.mock("./chat/ChatPane", () => ({
  default: () => {
    if (throwFlags.chatPane) throw new Error("chat pane boom");
    return <div data-testid="chat-pane-ok">chat ok</div>;
  },
}));

import AppShell from "./AppShell";
import { useDashboardStore } from "../stores/dashboardStore";

beforeEach(() => {
  useDashboardStore.setState({ dashboards: [], activeId: null });
  throwFlags.widgetLibrary = false;
  throwFlags.backendsDialog = false;
  throwFlags.settingsDialog = false;
  throwFlags.chatPane = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppShell top-level panes/dialogs are each wrapped in an ErrorBoundary (Finding 4)", () => {
  it("WidgetLibrary: a render throw degrades to an error card, not a dead app", () => {
    throwFlags.widgetLibrary = true;
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Widget Library" }));

    expect(document.querySelector(".error-box")).toBeInTheDocument();
    // The rest of the shell is still alive.
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
  });

  it("BackendsDialog: a render throw degrades to an error card, not a dead app", () => {
    throwFlags.backendsDialog = true;
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));

    expect(document.querySelector(".error-box")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
  });

  it("SettingsDialog: a render throw degrades to an error card, not a dead app", () => {
    throwFlags.settingsDialog = true;
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(document.querySelector(".error-box")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
  });

  it("ChatPane: a render throw degrades to an error card, not a dead app", () => {
    throwFlags.chatPane = true;
    render(<AppShell />);
    // ChatPane only mounts once the Rita pane is expanded (hover or pinned).
    fireEvent.mouseEnter(screen.getByLabelText("Rita AI pane"));

    expect(document.querySelector(".error-box")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Navigation rail" })).toBeInTheDocument();
  });

  it("a throw in one dialog does not unmount a sibling dialog opened at the same time", () => {
    throwFlags.settingsDialog = true;
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(document.querySelector(".error-box")).toBeInTheDocument();
    // BackendsDialog (opened first, never throws) is still fully rendered.
    expect(screen.getByTestId("backends-dialog-ok")).toBeInTheDocument();
  });

  it("nothing throws: all four render normally side by side with the dashboard grid", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Widget Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Backends" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.mouseEnter(screen.getByLabelText("Rita AI pane"));

    expect(document.querySelector(".error-box")).not.toBeInTheDocument();
    expect(screen.getByTestId("widget-library-ok")).toBeInTheDocument();
    expect(screen.getByTestId("backends-dialog-ok")).toBeInTheDocument();
    expect(screen.getByTestId("settings-dialog-ok")).toBeInTheDocument();
    expect(screen.getByTestId("chat-pane-ok")).toBeInTheDocument();
  });
});
