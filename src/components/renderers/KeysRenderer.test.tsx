import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import KeysRenderer from "./KeysRenderer";
import { makeWidgetDef } from "../../test/widgetDef";

const WIDGET = makeWidgetDef({ id: "provider_api_keys_panel", type: "keys" });

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
