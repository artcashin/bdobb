import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetLibrary } from "./WidgetLibrary";
import type { WidgetDef } from "../lib/types";
import { useProviderKeysStore } from "../stores/providerKeysStore";

describe("WidgetLibrary", () => {
  const mockWidgets: WidgetDef[] = [
    {
      id: "widget_1",
      name: "Historical Prices",
      description: "Get historical price data for stocks",
      category: "Equity",
      subCategory: "Price",
      type: "table",
      endpoint: "/api/v1/equity/price/historical",
      gridData: { w: 40, h: 15 },
      source: ["Eodhd"],
      runButton: false,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: "results",
      columnsDefs: [],
      mcpUrl: null,
      backendId: "test",
    },
    {
      id: "widget_2",
      name: "IMF Data",
      description: "International Monetary Fund presentation tables",
      category: "IMF",
      subCategory: "Presentation",
      type: "html",
      endpoint: "/api/v1/imf_utils/presentation_table",
      gridData: { w: 40, h: 15 },
      source: ["IMF"],
      runButton: false,
      raw: true,
      refetchInterval: null,
      params: [],
      dataKey: null,
      columnsDefs: [],
      mcpUrl: null,
      backendId: "test",
    },
    {
      id: "widget_3",
      name: "Portfolio",
      description: "Portfolio dashboard widget",
      category: "Portfolio",
      subCategory: "Analytics",
      type: "chart",
      endpoint: "/api/v1/portfolio/summary",
      gridData: { w: 40, h: 20 },
      source: ["Internal"],
      runButton: true,
      raw: false,
      refetchInterval: null,
      params: [],
      dataKey: "chart",
      columnsDefs: null,
      mcpUrl: null,
      backendId: "test",
    },
  ];

  it("renders widget library header", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByText("Widget Library")).toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByPlaceholderText("Search widgets...")).toBeInTheDocument();
  });

  // desk hardening, ported: an explicit accessible name (not just a
  // placeholder, which some screen readers don't announce) and autofocus so
  // opening the library drops the user straight into search.
  it("gives the search input an accessible name and focuses it on open", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    const search = screen.getByRole("textbox", { name: "Search widgets" });
    expect(search).toBeInTheDocument();
    expect(document.activeElement).toBe(search);
  });

  it("renders category filters", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Equity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "IMF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Portfolio" })).toBeInTheDocument();
  });

  it("displays widgets with metadata", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByText("Historical Prices")).toBeInTheDocument();
    expect(screen.getByText("Get historical price data for stocks")).toBeInTheDocument();
    const equityElements = screen.getAllByText("Equity");
    expect(equityElements.length).toBeGreaterThan(0);
    expect(screen.getByText("table")).toBeInTheDocument();
  });

  it("filters widgets by category", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    const equityBtn = screen.getByRole("button", { name: "Equity" });
    fireEvent.click(equityBtn);

    expect(screen.getByText("Historical Prices")).toBeInTheDocument();
    expect(screen.queryByText("Get historical price data for stocks")).toBeInTheDocument();
    expect(screen.queryByText("IMF Data")).not.toBeInTheDocument();
    expect(screen.queryByText("Portfolio dashboard widget")).not.toBeInTheDocument();
  });

  it("filters widgets by search term", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    const searchInput = screen.getByPlaceholderText("Search widgets...");
    fireEvent.change(searchInput, { target: { value: "dashboard" } });

    expect(screen.getByText("Portfolio dashboard widget")).toBeInTheDocument();
    expect(screen.queryByText("Get historical price data for stocks")).not.toBeInTheDocument();
    expect(screen.queryByText("International Monetary Fund")).not.toBeInTheDocument();
  });

  it("calls onSelectWidget when widget clicked", () => {
    const handleSelect = vi.fn();
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={handleSelect} />);
    const widgetCard = screen.getByText("Historical Prices").closest(".widget-library-widget");
    if (widgetCard) {
      fireEvent.click(widgetCard);
    }
    expect(handleSelect).toHaveBeenCalled();
  });

  it("closes when onClose called", () => {
    const handleClose = vi.fn();
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} onClose={handleClose} />);
    const closeBtn = screen.getByRole("button", { name: /Close modal/i });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalled();
  });

  it("handles empty widget list", () => {
    render(<WidgetLibrary widgets={[]} onSelectWidget={() => {}} />);
    expect(screen.getByText("No widgets found")).toBeInTheDocument();
  });

  it("shows widget type badge", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByText("table")).toBeInTheDocument();
    expect(screen.getByText("html")).toBeInTheDocument();
    expect(screen.getByText("chart")).toBeInTheDocument();
  });

  it("shows widget source as the provider badge", () => {
    useProviderKeysStore.setState({ status: {}, source: "none" });
    const { container } = render(
      <WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />
    );
    const badges = [...container.querySelectorAll(".widget-library-widget-provider")];
    expect(badges.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Eodhd", "IMF", "Internal"])
    );
  });

  it("exposes each entry as a keyboard-reachable button", () => {
    // The entries were divs with onClick: focusable by nothing, activatable by
    // no key, and announced as an unlabelled group.
    const handleSelect = vi.fn();
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={handleSelect} />);
    const entry = screen.getByRole("button", { name: /Historical Prices/ });

    entry.focus();
    expect(document.activeElement).toBe(entry);

    fireEvent.click(entry);
    expect(handleSelect).toHaveBeenCalled();
  });

  // Desk hardening, adapted: two backends can legitimately expose a widget
  // with the same id, and keying entries by bare `widget.id` collided them
  // into one React node.
  it("keys entries by backend and widget id so same-id widgets from different backends don't collide", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dupWidgets: WidgetDef[] = [
      { ...mockWidgets[0], id: "dup_id", name: "NAS Widget", backendId: "nas" },
      { ...mockWidgets[0], id: "dup_id", name: "Other Widget", backendId: "other" },
    ];
    render(<WidgetLibrary widgets={dupWidgets} onSelectWidget={() => {}} />);
    expect(screen.getByText("NAS Widget")).toBeInTheDocument();
    expect(screen.getByText("Other Widget")).toBeInTheDocument();
    const duplicateKeyWarning = consoleError.mock.calls.some(([msg]) =>
      typeof msg === "string" && msg.includes("same key")
    );
    expect(duplicateKeyWarning).toBe(false);
    consoleError.mockRestore();
  });

  // Desk hardening, adapted: search used to check only name+description, so
  // a search for a category or subCategory visible right on the card (e.g.
  // "IMF" or "Analytics") found nothing.
  it("searches description, category and subCategory, not just name", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    const searchInput = screen.getByPlaceholderText("Search widgets...");

    fireEvent.change(searchInput, { target: { value: "IMF" } });
    expect(screen.getByText("IMF Data")).toBeInTheDocument();
    expect(screen.queryByText("Historical Prices")).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: "Analytics" } });
    expect(screen.getByText("Portfolio dashboard widget")).toBeInTheDocument();
    expect(screen.queryByText("Historical Prices")).not.toBeInTheDocument();
  });

  it("trims whitespace off the query before matching", () => {
    render(<WidgetLibrary widgets={mockWidgets} onSelectWidget={() => {}} />);
    const searchInput = screen.getByPlaceholderText("Search widgets...");
    fireEvent.change(searchInput, { target: { value: "  imf data  " } });

    expect(screen.getByText("IMF Data")).toBeInTheDocument();
    expect(screen.queryByText("Historical Prices")).not.toBeInTheDocument();
  });

  describe("provider badge", () => {
    it("shows the provider with its key status as the badge class", () => {
      useProviderKeysStore.setState({
        status: { eodhd: "keyed", imf: "unkeyed" },
        source: "key-maint",
      });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      const eodhd = screen.getByText("Eodhd");
      expect(eodhd.className).toContain("widget-library-widget-provider");
      expect(eodhd.className).toContain("keyed");
      expect(screen.getByText("IMF", { selector: ".widget-library-widget-provider" }).className).toContain(
        "unkeyed"
      );
    });

    it("marks providers unknown while no source has answered", () => {
      useProviderKeysStore.setState({ status: {}, source: "none" });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);
      expect(screen.getByText("Eodhd").className).toContain("unknown");
    });

    it("renders no badge for a widget without a source", () => {
      useProviderKeysStore.setState({ status: {}, source: "key-maint" });
      const sourceless = [{ ...mockWidgets[0], id: "s", source: [] as string[] }];
      const { container } = render(
        <WidgetLibrary onSelectWidget={vi.fn()} widgets={sourceless} />
      );
      expect(container.querySelector(".widget-library-widget-provider")).toBeNull();
    });

    it("carries the key status as accessible text, not just badge color", () => {
      // Color alone (keyed green vs unkeyed red) doesn't reach screen-reader
      // users or color-vision-deficient users — this asserts a textual
      // carrier (title/aria-label) exists and reads naturally, not just the
      // raw "keyed"/"unkeyed" token.
      useProviderKeysStore.setState({
        status: { eodhd: "keyed", imf: "unkeyed" },
        source: "key-maint",
      });
      render(<WidgetLibrary onSelectWidget={vi.fn()} widgets={mockWidgets} />);

      const eodhd = screen.getByText("Eodhd", { selector: ".widget-library-widget-provider" });
      const eodhdLabel = eodhd.getAttribute("aria-label") ?? eodhd.getAttribute("title");
      expect(eodhdLabel).toBeTruthy();
      expect(eodhdLabel).not.toBe("keyed");
      expect(eodhdLabel!.toLowerCase()).toContain("eodhd");
      expect(eodhdLabel!.toLowerCase()).toMatch(/key/);
      expect(eodhdLabel!.toLowerCase()).not.toMatch(/no api key|missing|fail/);

      const imf = screen.getByText("IMF", { selector: ".widget-library-widget-provider" });
      const imfLabel = imf.getAttribute("aria-label") ?? imf.getAttribute("title");
      expect(imfLabel).toBeTruthy();
      expect(imfLabel).not.toBe("unkeyed");
      expect(imfLabel!.toLowerCase()).toContain("imf");
      expect(imfLabel!.toLowerCase()).toMatch(/no.*key|missing.*key|fail/);
    });
  });
});
