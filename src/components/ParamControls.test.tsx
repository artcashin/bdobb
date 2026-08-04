import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig, ParamDef, ParamValues, WidgetDef } from "../lib/types";

const fetchJson = vi.fn();
vi.mock("../lib/dataClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/dataClient")>();
  return {
    ...actual,
    fetchJson: (...args: unknown[]) => fetchJson(...args),
  };
});

const logError = vi.fn();
vi.mock("../lib/logger", () => ({
  logError: (message: string) => logError(message),
}));

import { ParamControls } from "./ParamControls";

const backend: BackendConfig = { id: "nas", name: "NAS", baseUrl: "https://openbb.example" };

function mkWidget(params: ParamDef[], id = "w1"): WidgetDef {
  return {
    id,
    name: "Widget",
    description: "",
    category: "Cat",
    subCategory: null,
    type: "table",
    endpoint: "/x",
    gridData: { w: 10, h: 5 },
    source: [],
    runButton: false,
    raw: false,
    refetchInterval: null,
    params,
    dataKey: null,
    columnsDefs: null,
    mcpUrl: null,
    backendId: "nas",
  };
}

function mkEndpointParam(overrides: Partial<ParamDef> & Pick<ParamDef, "paramName">): ParamDef {
  return {
    type: "endpoint",
    label: overrides.paramName,
    description: "",
    // Not null: ParamControls appends a "*" to the label when `value ===
    // null` (a qwen indicator desk's ParamControls doesn't have), which
    // would otherwise break an exact getByLabelText(paramName) match below.
    value: "",
    show: true,
    multiSelect: false,
    options: null,
    optionsEndpoint: null,
    optionsParams: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchJson.mockReset();
});

describe("ParamControls", () => {
  const mockParams: ParamDef[] = [
    {
      paramName: "symbol",
      type: "text",
      value: "AAPL",
      label: "Symbol",
      description: "Stock symbol",
      show: true,
      multiSelect: false,
      options: null,
      optionsEndpoint: null,
      optionsParams: null,
    },
    {
      paramName: "interval",
      type: "endpoint",
      value: "1d",
      label: "Interval",
      description: "Time interval",
      show: true,
      multiSelect: false,
      options: [
        { label: "1m", value: "1m" },
        { label: "1d", value: "1d" },
        { label: "1w", value: "1w" },
      ],
      optionsEndpoint: null,
      optionsParams: null,
    },
    {
      paramName: "limit",
      type: "number",
      value: 10,
      label: "Limit",
      description: "Maximum records",
      show: true,
      multiSelect: false,
      options: null,
      optionsEndpoint: null,
      optionsParams: null,
    },
    {
      paramName: "raw",
      type: "boolean",
      value: false,
      label: "Raw Output",
      description: "Return raw data",
      show: true,
      multiSelect: false,
      options: null,
      optionsEndpoint: null,
      optionsParams: null,
    },
    {
      paramName: "hidden_param",
      type: "text",
      value: "hidden",
      label: "Hidden",
      description: "Hidden parameter",
      show: false,
      multiSelect: false,
      options: null,
      optionsEndpoint: null,
      optionsParams: null,
    },
  ];

  const initialValues: ParamValues = {
    symbol: "AAPL",
    interval: "1d",
    limit: 10,
    raw: false,
  };

  it("renders all visible parameters", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    expect(screen.getByLabelText("Symbol")).toBeInTheDocument();
    expect(screen.getByLabelText("Interval")).toBeInTheDocument();
    expect(screen.getByLabelText("Limit")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Raw Output/ })).toBeInTheDocument();
  });

  it("does not render hidden parameters", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    expect(screen.queryByText("Hidden")).not.toBeInTheDocument();
  });

  it("handles text input changes", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    const input = screen.getByLabelText("Symbol") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "MSFT" } });

    expect(handleChange).toHaveBeenCalledWith({ ...initialValues, symbol: "MSFT" });
  });

  it("handles number input changes", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    const input = screen.getByLabelText("Limit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25" } });

    expect(handleChange).toHaveBeenCalledWith({ ...initialValues, limit: 25 });
  });

  it("handles boolean changes", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    const checkbox = screen.getByRole("checkbox", { name: /Raw Output/ }) as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(handleChange).toHaveBeenCalledWith({ ...initialValues, raw: true });
  });

  it("handles select dropdown changes", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    const select = screen.getByRole("combobox", { name: "Interval" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1w" } });

    expect(handleChange).toHaveBeenCalledWith({ ...initialValues, interval: "1w" });
  });

  it("handles text input as endpoint without options", () => {
    const textParams: ParamDef[] = [
      {
        paramName: "custom_endpoint",
        type: "endpoint",
        value: "default",
        label: "Custom Endpoint",
        description: "Custom endpoint input",
        show: true,
        multiSelect: false,
        options: [],
        optionsEndpoint: null,
        optionsParams: null,
      },
    ];

    const handleChange = vi.fn();
    render(<ParamControls params={textParams} values={{ custom_endpoint: "default" }} onChange={handleChange} />);

    const input = screen.getByRole("textbox", { name: "Custom Endpoint" }) as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it("handles empty number input as null", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={mockParams} values={initialValues} onChange={handleChange} />);

    const input = screen.getByLabelText("Limit") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });

    expect(handleChange).toHaveBeenCalledWith({ ...initialValues, limit: null });
  });

  it("renders options from widgetDef", () => {
    const handleChange = vi.fn();
    const options = {
      interval: [
        { label: "1m", value: "1m" },
        { label: "5m", value: "5m" },
      ],
    };

    const paramsWithInterval: ParamDef[] = [
      {
        paramName: "interval",
        type: "endpoint",
        value: "1d",
        label: "Interval",
        description: "Time interval",
        show: true,
        multiSelect: false,
        options: [],
        optionsEndpoint: null,
        optionsParams: null,
      },
    ];

    render(
      <ParamControls
        params={paramsWithInterval}
        values={initialValues}
        onChange={handleChange}
        options={options}
      />
    );

    expect(screen.getByRole("option", { name: "1m" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "5m" })).toBeInTheDocument();
  });

  it("handles multiSelect with multiple values", () => {
    const multiSelectParams: ParamDef[] = [
      {
        paramName: "symbols",
        type: "endpoint",
        value: ["AAPL", "MSFT"],
        label: "Symbols",
        description: "Multiple symbols",
        show: true,
        multiSelect: true,
        options: [
          { label: "AAPL", value: "AAPL" },
          { label: "MSFT", value: "MSFT" },
          { label: "GOOGL", value: "GOOGL" },
        ],
        optionsEndpoint: null,
        optionsParams: null,
      },
    ];

    const handleChange = vi.fn();
    render(<ParamControls params={multiSelectParams} values={{ symbols: ["AAPL", "MSFT"] }} onChange={handleChange} />);

    const select = screen.getByRole("listbox", { name: "Symbols" }) as HTMLSelectElement;
    expect(select).toHaveAttribute("multiple");
  });
});

// Task 15 carried requirement: desk's resolveOptionsParams/normalizeOptions
// (forward-ported in Task 7, previously inert) wired into ParamControls'
// `optionsEndpoint` handling. Adapted from desk's ParamControls.test.tsx to
// qwen's whole-values `onChange(values)` callback and `widget`/`backend`
// props instead of desk's per-field `onChange(name, value)`.
describe("optionsEndpoint wiring", () => {
  it("fetches options from optionsEndpoint on mount when there are no unresolved dependencies", async () => {
    fetchJson.mockResolvedValue([{ label: "BOP", value: "BOP" }]);
    const p = mkEndpointParam({ paramName: "dataflow_group", optionsEndpoint: "/choices" });
    const widget = mkWidget([p], "imf");
    render(
      <ParamControls
        params={[p]} values={{ dataflow_group: null }} onChange={vi.fn()}
        widget={widget} backend={backend}
      />
    );
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    const [url] = fetchJson.mock.calls[0] as [string];
    expect(url).toContain("/choices");
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("dataflow_group")).getByRole("option", { name: "BOP" })
      ).toBeInTheDocument();
    });
  });

  it("does not render a blank/selectable placeholder option for a multiSelect optionsEndpoint param", async () => {
    // Reviewer finding: the blocked/error placeholder `<option value="">`
    // is a real, selectable list item in a multi-select control (unlike
    // single-select, where it's inert until chosen). Picking it would
    // inject "" into the values array, and serializeParams joins that
    // straight into the query string (e.g. "AAPL,"), corrupting the request.
    fetchJson.mockResolvedValue([
      { label: "AAPL", value: "AAPL" },
      { label: "MSFT", value: "MSFT" },
    ]);
    const p = mkEndpointParam({
      paramName: "symbols", optionsEndpoint: "/choices", multiSelect: true,
    });
    const widget = mkWidget([p], "screener");
    render(
      <ParamControls
        params={[p]} values={{ symbols: [] }} onChange={vi.fn()}
        widget={widget} backend={backend}
      />
    );
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    const select = screen.getByLabelText("symbols") as HTMLSelectElement;
    await waitFor(() => {
      expect(within(select).getByRole("option", { name: "AAPL" })).toBeInTheDocument();
    });
    expect(select).toHaveAttribute("multiple");
    // Exactly the two real options -- no extra blank/placeholder option.
    expect(select.options.length).toBe(2);
    expect(
      Array.from(select.options).some((o) => o.value === "")
    ).toBe(false);
  });

  it("routes a text-typed param carrying optionsEndpoint through the live select instead of free text", async () => {
    fetchJson.mockResolvedValue([{ label: "LAX", value: "LAX" }]);
    const p: ParamDef = {
      paramName: "port_code", type: "text", label: "Port", description: "",
      value: "", show: true, multiSelect: false, options: null,
      optionsEndpoint: "/port-choices", optionsParams: null,
    };
    const widget = mkWidget([p], "shipping");
    render(
      <ParamControls
        params={[p]} values={{ port_code: null }} onChange={vi.fn()}
        widget={widget} backend={backend}
      />
    );
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
    const control = screen.getByLabelText("Port");
    expect(control.tagName).toBe("SELECT");
    await waitFor(() => {
      expect(within(control).getByRole("option", { name: "LAX" })).toBeInTheDocument();
    });
  });

  it("does not fetch and skips endpoint resolution when widget/backend are not supplied (backward compatible)", () => {
    const p = mkEndpointParam({ paramName: "dataflow_group", optionsEndpoint: "/choices" });
    render(<ParamControls params={[p]} values={{ dataflow_group: null }} onChange={vi.fn()} />);
    expect(fetchJson).not.toHaveBeenCalled();
    // Falls back to the plain endpoint-without-options text input.
    expect(screen.getByRole("textbox", { name: "dataflow_group" })).toBeInTheDocument();
  });

  describe("cascading optionsParams", () => {
    function cascadeParams(): ParamDef[] {
      const dataflow = mkEndpointParam({ paramName: "dataflow_group", optionsEndpoint: "/choices" });
      const table = mkEndpointParam({
        paramName: "table", optionsEndpoint: "/choices",
        optionsParams: { dataflow_group: "$dataflow_group" },
      });
      return [dataflow, table];
    }

    it("does not fetch the child while its parent dependency is unset, and disables it with an indication", async () => {
      fetchJson.mockResolvedValue([]);
      const params = cascadeParams();
      const widget = mkWidget(params, "imf");
      render(
        <ParamControls
          params={params} values={{ dataflow_group: null, table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      // Only the parent (no deps) fetches; the child stays blocked.
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      const tableSelect = screen.getByLabelText("table") as HTMLSelectElement;
      expect(tableSelect.disabled).toBe(true);
      expect(tableSelect.options[0].text.toLowerCase()).toContain("first");
    });

    it("fetches the child with the resolved parent value once the dependency is set", async () => {
      fetchJson.mockResolvedValue([{ label: "GDP", value: "GDP" }]);
      const params = cascadeParams();
      const widget = mkWidget(params, "imf");
      const { rerender } = render(
        <ParamControls
          params={params} values={{ dataflow_group: null, table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      fetchJson.mockClear();

      rerender(
        <ParamControls
          params={params} values={{ dataflow_group: "BOP", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      const [url] = fetchJson.mock.calls[0] as [string];
      expect(url).toContain("dataflow_group=BOP");
      const tableSelect = screen.getByLabelText("table") as HTMLSelectElement;
      expect(tableSelect.disabled).toBe(false);
    });

    it("refetches when the dependency value changes to a different value", async () => {
      fetchJson.mockResolvedValue([]);
      const params = cascadeParams();
      const widget = mkWidget(params, "imf");
      const { rerender } = render(
        <ParamControls
          params={params} values={{ dataflow_group: "BOP", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      // parent + child both fetch on mount, since the dependency is already set.
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));
      fetchJson.mockClear();

      rerender(
        <ParamControls
          params={params} values={{ dataflow_group: "COFER", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      // only the child refetches; the parent's own resolved optionsParams (none) didn't change.
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      const [url] = fetchJson.mock.calls[0] as [string];
      expect(url).toContain("dataflow_group=COFER");
    });

    it("a stale in-flight response does not overwrite a newer one", async () => {
      let resolveFirst!: (v: unknown) => void;
      let resolveSecond!: (v: unknown) => void;
      const first = new Promise((r) => { resolveFirst = r; });
      const second = new Promise((r) => { resolveSecond = r; });
      fetchJson.mockImplementationOnce(() => first).mockImplementationOnce(() => second);

      const table = mkEndpointParam({
        paramName: "table", optionsEndpoint: "/choices",
        optionsParams: { dataflow_group: "$dataflow_group" },
      });
      const widget = mkWidget([table], "imf-single");
      const { rerender } = render(
        <ParamControls
          params={[table]} values={{ dataflow_group: "BOP", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));

      rerender(
        <ParamControls
          params={[table]} values={{ dataflow_group: "COFER", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(2));

      // Resolve OUT OF ORDER: the newer (second) request settles first, then
      // the stale (first) request settles after — its result must be ignored.
      resolveSecond([{ label: "COFER-OPT", value: "COFER-OPT" }]);
      await waitFor(() => {
        expect(
          within(screen.getByLabelText("table")).getByRole("option", { name: "COFER-OPT" })
        ).toBeInTheDocument();
      });
      resolveFirst([{ label: "STALE-OPT", value: "STALE-OPT" }]);
      await new Promise((r) => setTimeout(r, 0));
      expect(
        within(screen.getByLabelText("table")).queryByRole("option", { name: "STALE-OPT" })
      ).not.toBeInTheDocument();
    });
  });

  describe("optionsEndpoint failure state", () => {
    it("shows a visible, distinct error state when the fetch rejects, and still logs", async () => {
      fetchJson.mockRejectedValue(new Error("HTTP 400: Bad Request"));
      const p = mkEndpointParam({ paramName: "dataflow_group", optionsEndpoint: "/choices" });
      const widget = mkWidget([p], "imf");
      render(
        <ParamControls
          params={[p]} values={{ dataflow_group: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(logError).toHaveBeenCalledTimes(1));
      expect(String(logError.mock.calls[0][0])).toContain("dataflow_group");

      const alert = await waitFor(() => screen.getByRole("alert"));
      expect(alert.textContent?.toLowerCase()).toMatch(/failed|error/);

      const select = screen.getByLabelText("dataflow_group") as HTMLSelectElement;
      expect(select.disabled).toBe(true);
      expect(select.options[0].text.toLowerCase()).not.toContain("first");
    });

    it("does not show the failure state while genuinely blocked on an unresolved parent param", async () => {
      fetchJson.mockResolvedValue([]);
      const params = [
        mkEndpointParam({ paramName: "dataflow_group", optionsEndpoint: "/choices" }),
        mkEndpointParam({
          paramName: "table", optionsEndpoint: "/choices",
          optionsParams: { dataflow_group: "$dataflow_group" },
        }),
      ];
      const widget = mkWidget(params, "imf");
      render(
        <ParamControls
          params={params} values={{ dataflow_group: null, table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1));
      const tableSelect = screen.getByLabelText("table") as HTMLSelectElement;
      expect(tableSelect.disabled).toBe(true);
      expect(tableSelect.options[0].text.toLowerCase()).toContain("first");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("clears a previous error once a refetch (triggered by a changed dependency) succeeds", async () => {
      fetchJson.mockRejectedValueOnce(new Error("HTTP 500"));
      const table = mkEndpointParam({
        paramName: "table", optionsEndpoint: "/choices",
        optionsParams: { dataflow_group: "$dataflow_group" },
      });
      const widget = mkWidget([table], "imf-single");
      const { rerender } = render(
        <ParamControls
          params={[table]} values={{ dataflow_group: "BOP", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

      fetchJson.mockResolvedValueOnce([{ label: "GDP", value: "GDP" }]);
      rerender(
        <ParamControls
          params={[table]} values={{ dataflow_group: "COFER", table: null }} onChange={vi.fn()}
          widget={widget} backend={backend}
        />
      );
      await waitFor(() => {
        expect(
          within(screen.getByLabelText("table")).getByRole("option", { name: "GDP" })
        ).toBeInTheDocument();
      });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });
});

// desk hardening: the plain `Number(e.target.value)` cast let a lone "-"
// (or any non-numeric intermediate string) become `NaN`, which
// `typeof NaN === "number"` then rendered as the literal text "NaN".
describe("number param NaN guard", () => {
  const numberParams: ParamDef[] = [
    {
      // Not null: ParamControls appends a "*" to the label when `value ===
      // null`, which would break an exact getByLabelText("Limit") match.
      paramName: "limit", type: "number", value: 0, label: "Limit", description: "",
      show: true, multiSelect: false, options: null, optionsEndpoint: null, optionsParams: null,
    },
  ];

  it("does not turn a lone '-' keystroke into NaN", () => {
    const handleChange = vi.fn();
    render(<ParamControls params={numberParams} values={{ limit: null }} onChange={handleChange} />);
    const input = screen.getByLabelText("Limit") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "-" } });
    expect(input.value).toBe("-");
    expect(handleChange).not.toHaveBeenCalled();
  });

  it("allows entering a decimal value like 0.5 keystroke by keystroke without wiping the intermediate value", () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <ParamControls params={numberParams} values={{ limit: null }} onChange={handleChange} />
    );
    const input = screen.getByLabelText("Limit") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "0" } });
    expect(handleChange).toHaveBeenLastCalledWith({ limit: 0 });
    rerender(<ParamControls params={numberParams} values={{ limit: 0 }} onChange={handleChange} />);

    fireEvent.change(input, { target: { value: "0." } });
    rerender(<ParamControls params={numberParams} values={{ limit: 0 }} onChange={handleChange} />);
    expect(input.value).toBe("0.");

    fireEvent.change(input, { target: { value: "0.5" } });
    expect(handleChange).toHaveBeenLastCalledWith({ limit: 0.5 });
  });

  it("does not render NaN for a persisted non-numeric value", () => {
    render(<ParamControls params={numberParams} values={{ limit: "abc" }} onChange={vi.fn()} />);
    const input = screen.getByLabelText("Limit") as HTMLInputElement;
    expect(input.value).not.toBe("NaN");
    expect(input.value).toBe("");
  });
});
