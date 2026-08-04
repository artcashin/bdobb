import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StatusTrail from "./StatusTrail";
import type { StatusUpdate } from "../../lib/agent/types";

// Shapes taken from a real turn (src/test/fixtures/rita-artifact-stream.sse).
const STEPS: StatusUpdate[] = [
  { eventType: "INFO", message: "Extracting table from text", group: "reasoning",
    tool_call: { tool_name: "create_table_from_text" } },
  { eventType: "INFO", message: "create_table_from_text returned a result", group: "reasoning" },
];

describe("StatusTrail", () => {
  it("renders nothing when there are no steps", () => {
    const { container } = render(<StatusTrail statuses={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays expanded and shows the latest step while the turn is live", () => {
    render(<StatusTrail statuses={STEPS} live />);
    // The live summary echoes the newest step, so it appears twice; assert on
    // the list rather than the ambiguous text.
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("Extracting table from text");
    expect(items[1]).toContain("create_table_from_text returned a result");
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses to a summary once the turn finishes, and reopens on click", () => {
    render(<StatusTrail statuses={STEPS} />);
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.queryByText("Extracting table from text")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Extracting table from text")).toBeInTheDocument();
  });

  it("names the tool a step invoked", () => {
    render(<StatusTrail statuses={STEPS} live />);
    const [first] = screen.getAllByRole("listitem");
    expect(first.querySelector("code")?.textContent).toBe("create_table_from_text");
  });

  it("counts errors in the collapsed summary", () => {
    render(
      <StatusTrail
        statuses={[...STEPS, { eventType: "ERROR", message: "tool failed" }]}
      />
    );
    expect(screen.getByText(/1 error/)).toBeInTheDocument();
  });

  it("omits steps the agent marked hidden", () => {
    render(
      <StatusTrail
        statuses={[{ eventType: "INFO", message: "internal", hidden: true }]}
        live
      />
    );
    expect(screen.queryByText("internal")).not.toBeInTheDocument();
  });
});
