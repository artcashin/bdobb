import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import KeysRenderer from "./KeysRenderer";
import { makeWidgetDef } from "../../test/widgetDef";
import type { BackendConfig } from "../../lib/types";

const WIDGET = makeWidgetDef({ id: "provider_api_keys_panel", type: "keys", endpoint: "/keys" });

const BACKEND: BackendConfig = {
  id: "b1",
  name: "Test backend",
  baseUrl: "https://openbb.example.ts.net:6900",
};

/** The /keys envelope, with one row per case under test. */
function data(rows: unknown[], tier = 1) {
  return { tier, rows };
}

const OWN = { provider: "FMP", env_var: "FMP_API_KEY", status: "set", demo: false };
const DEMO = { provider: "EODHD", env_var: "EODHD_API_KEY", status: "set", demo: true };
const UNSET = { provider: "Tiingo", env_var: "TIINGO_TOKEN", status: "empty", demo: false };

function renderKeys(rows: unknown[], tier = 1) {
  return render(
    <KeysRenderer data={data(rows, tier)} widgetDef={WIDGET} theme="dark" />
  );
}

describe("KeysRenderer pills", () => {
  it("names each key state in the pill's own text", () => {
    renderKeys([OWN, DEMO, UNSET]);
    expect(screen.getByText("Own key")).toBeInTheDocument();
    expect(screen.getByText("Demo key")).toBeInTheDocument();
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("colours the pill by key state", () => {
    // classList.contains, never className.toContain: a bare substring match
    // passes on the wrong class when one name contains another.
    const { container } = renderKeys([OWN, DEMO, UNSET]);
    const pills = [...container.querySelectorAll(".keys-pill")];
    expect(pills[0].classList.contains("own")).toBe(true);
    expect(pills[1].classList.contains("demo")).toBe(true);
    expect(pills[2].classList.contains("unset")).toBe(true);
  });
});

describe("KeysRenderer reachability dot", () => {
  const withTest = (row: object, result: string) => ({
    ...row,
    test: { result, detail: `stub ${result}` },
  });

  it("paints red only when the vendor never answered", () => {
    const { container } = renderKeys([withTest(OWN, "no_response")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("down")).toBe(true);
  });

  it("paints amber when the vendor answered with an error", () => {
    const { container } = renderKeys([withTest(OWN, "error")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("warn")).toBe(true);
  });

  it("treats a 200 rejected by body as amber, not green", () => {
    // Alpha Vantage and FMP report a bad key with HTTP 200 and an error
    // string, so the status code alone is not the signal.
    const { container } = renderKeys([withTest(OWN, "auth_failed")]);
    const dot = container.querySelector(".keys-dot")!;
    expect(dot.classList.contains("warn")).toBe(true);
    expect(dot.classList.contains("ok")).toBe(false);
  });

  it("paints green only on a clean probe", () => {
    const { container } = renderKeys([withTest(OWN, "ok")]);
    expect(container.querySelector(".keys-dot")!.classList.contains("ok")).toBe(true);
  });

  it("is neutral when no probe has run", () => {
    const { container } = renderKeys([OWN]);
    expect(container.querySelector(".keys-dot")!.classList.contains("idle")).toBe(true);
  });

  it("names the server state in text, so colour is not the only carrier", () => {
    renderKeys([withTest(OWN, "no_response")]);
    expect(screen.getByLabelText(/not responding/i)).toBeInTheDocument();
  });
});

describe("KeysRenderer secrecy", () => {
  it("never renders a key value, even when the row carries one", () => {
    // Tier-3 rows include `value`; this renderer must not put it in the DOM.
    const { container } = renderKeys([{ ...OWN, value: "supersecret999" }], 3);
    expect(container.textContent).not.toContain("supersecret999");
  });
});

describe("KeysRenderer table behaviour", () => {
  it("sorts by provider when the header is clicked", () => {
    const { container } = renderKeys([UNSET, OWN]);
    const before = [...container.querySelectorAll(".keys-provider")].map((e) => e.textContent);
    expect(before).toEqual(["Tiingo", "FMP"]);
    fireEvent.click(screen.getByText("Provider"));
    const after = [...container.querySelectorAll(".keys-provider")].map((e) => e.textContent);
    expect(after).toEqual(["FMP", "Tiingo"]);
  });
});

/**
 * Fetch double for the probing tests. Dispatches on the URL: `run_tests=true`
 * hits the all-providers sweep, `/{env_var}/test` hits the single-provider
 * endpoint. `probeResult`, when set, attaches a test result to every row in
 * the sweep response; left unset (the default) the sweep echoes rows
 * untested, so a later single-provider test's effect on just one dot is
 * visible against an otherwise-idle field.
 */
function asMock(fetchImpl: typeof fetch) {
  return fetchImpl as unknown as ReturnType<typeof vi.fn>;
}

function makeFetchImpl(rows: unknown[], opts: { probeResult?: string } = {}) {
  return vi.fn(async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.searchParams.get("run_tests") === "true") {
      const outRows = opts.probeResult
        ? rows.map((r) => ({
            ...(r as object),
            test: { result: opts.probeResult, detail: `swept ${opts.probeResult}` },
          }))
        : rows;
      return new Response(JSON.stringify({ tier: 2, rows: outRows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const m = u.pathname.match(/\/([^/]+)\/test$/);
    if (m) {
      return new Response(
        JSON.stringify({ result: "ok", detail: `tested ${decodeURIComponent(m[1])}` }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function renderProbeableKeys(
  rows: unknown[],
  over: Partial<Parameters<typeof KeysRenderer>[0]> = {}
) {
  return render(
    <KeysRenderer
      data={data(rows)}
      widgetDef={WIDGET}
      theme="dark"
      backend={BACKEND}
      fetchImpl={makeFetchImpl(rows)}
      {...over}
    />
  );
}

describe("KeysRenderer probe cadence", () => {
  it("probes once on mount and not again on re-render", async () => {
    const fetchImpl = makeFetchImpl([OWN, DEMO, UNSET]);
    const { rerender } = render(
      <KeysRenderer
        data={data([OWN, DEMO, UNSET])}
        widgetDef={WIDGET}
        theme="dark"
        backend={BACKEND}
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [calledUrl] = asMock(fetchImpl).mock.calls[0];
    expect(String(calledUrl)).toContain("run_tests=true");

    // A re-render (new data reference, same content) must not re-fire the
    // sweep -- that's ~18 vendor calls on every dashboard open otherwise.
    rerender(
      <KeysRenderer
        data={data([OWN, DEMO, UNSET])}
        widgetDef={WIDGET}
        theme="dark"
        backend={BACKEND}
        fetchImpl={fetchImpl}
      />
    );
    await act(async () => {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probes exactly once under React StrictMode's double effect invocation", async () => {
    // StrictMode (dev only) mounts, runs effects, tears them down, and runs
    // them again on the SAME component instance to flush out missing
    // cleanup. If the probe-once guard were re-created per effect run
    // instead of living in a ref that survives the double-invoke, this would
    // fire the sweep twice.
    const fetchImpl = makeFetchImpl([OWN]);
    render(
      <StrictMode>
        <KeysRenderer
          data={data([OWN])}
          widgetDef={WIDGET}
          theme="dark"
          backend={BACKEND}
          fetchImpl={fetchImpl}
        />
      </StrictMode>
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    // Give a wrongly-guarded second invocation a chance to fire before
    // asserting it didn't.
    await act(async () => {});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-probes only when Refresh is pressed", async () => {
    const fetchImpl = makeFetchImpl([OWN]);
    render(
      <KeysRenderer
        data={data([OWN])}
        widgetDef={WIDGET}
        theme="dark"
        backend={BACKEND}
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    for (const call of asMock(fetchImpl).mock.calls) {
      expect(String(call[0])).toContain("run_tests=true");
    }
  });
});

describe("KeysRenderer right-click test", () => {
  it("opens a context menu on right-click with a Test this service item", async () => {
    const { container } = renderProbeableKeys([OWN]);
    await waitFor(() => expect(container.querySelectorAll(".keys-provider")).toHaveLength(1));
    fireEvent.contextMenu(container.querySelector("tbody tr")!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /test this service/i })).toBeInTheDocument();
  });

  it("tests only the right-clicked provider and updates that row's dot", async () => {
    const fetchImpl = makeFetchImpl([OWN, DEMO]);
    const { container } = render(
      <KeysRenderer
        data={data([OWN, DEMO])}
        widgetDef={WIDGET}
        theme="dark"
        backend={BACKEND}
        fetchImpl={fetchImpl}
      />
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    asMock(fetchImpl).mockClear();

    const rows = container.querySelectorAll("tbody tr");
    fireEvent.contextMenu(rows[0]); // FMP / OWN
    fireEvent.click(screen.getByRole("menuitem", { name: /test this service/i }));

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const [calledUrl] = asMock(fetchImpl).mock.calls[0];
    expect(String(calledUrl)).toContain("/keys/FMP_API_KEY/test");
    expect(String(calledUrl)).not.toContain("run_tests=true");

    // The all-providers sweep must not have been re-fired by a single test.
    expect(
      asMock(fetchImpl).mock.calls.every((call: unknown[]) => !String(call[0]).includes("run_tests=true"))
    ).toBe(true);

    await waitFor(() => {
      const dots = container.querySelectorAll(".keys-dot");
      expect(dots[0].classList.contains("ok")).toBe(true);
    });
    const dots = container.querySelectorAll(".keys-dot");
    // The DEMO row was never tested -- still neutral.
    expect(dots[1].classList.contains("idle")).toBe(true);
  });

  it("closes the context menu on Escape", async () => {
    const { container } = renderProbeableKeys([OWN]);
    await waitFor(() => expect(container.querySelectorAll(".keys-provider")).toHaveLength(1));
    fireEvent.contextMenu(container.querySelector("tbody tr")!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("dismisses the context menu on an outside click", async () => {
    const { container } = renderProbeableKeys([OWN]);
    await waitFor(() => expect(container.querySelectorAll(".keys-provider")).toHaveLength(1));
    fireEvent.contextMenu(container.querySelector("tbody tr")!);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is keyboard reachable and arrow-navigable between items", async () => {
    const { container } = renderProbeableKeys([OWN]);
    await waitFor(() => expect(container.querySelectorAll(".keys-provider")).toHaveLength(1));
    const row = container.querySelector("tbody tr")! as HTMLElement;
    row.focus();
    // The standard cross-browser "open context menu" key, for a user who
    // never touches a mouse.
    fireEvent.keyDown(row, { key: "ContextMenu" });
    const item = screen.getByRole("menuitem", { name: /test this service/i });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(item).toHaveFocus();
    // Only one item today, so arrow keys must keep it reachable (wrap to
    // itself) rather than losing focus out of the menu entirely.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(item).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(item).toHaveFocus();
  });
});
