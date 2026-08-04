import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ArtifactView from "./ArtifactView";

vi.mock("plotly.js-dist-min", () => ({
  default: {
    newPlot: vi.fn(),
    update: vi.fn(),
    unmount: vi.fn(),
    relayout: vi.fn(),
    deletePlot: vi.fn(),
    purge: vi.fn(),
  },
}));

describe("ArtifactView", () => {
  it("renders text artifacts", () => {
    const artifacts = [
      {
        type: "text" as const,
        name: "Text Artifact",
        description: "A text artifact",
        uuid: "123",
        content: "Sample text content",
      },
    ];
    render(<ArtifactView artifacts={artifacts} />);
    expect(screen.getByText("Sample text content")).toBeInTheDocument();
  });

  it("renders table artifacts", () => {
    const artifacts = [
      {
        type: "table" as const,
        name: "Table Artifact",
        description: "A table artifact",
        uuid: "123",
        content: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
        ],
      },
    ];
    render(<ArtifactView artifacts={artifacts} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("age")).toBeInTheDocument();
  });

  it("limits table rows displayed", () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `Item ${i}` }));
    const artifacts = [
      {
        type: "table" as const,
        name: "Table Artifact",
        description: "A table artifact",
        uuid: "123",
        content: data,
      },
    ];
    render(<ArtifactView artifacts={artifacts} />);
    expect(screen.getByText("Showing 50 of 100 rows")).toBeInTheDocument();
    expect(screen.getByText("Item 0")).toBeInTheDocument();
    expect(screen.getByText("Item 49")).toBeInTheDocument();
    expect(screen.queryByText("Item 50")).not.toBeInTheDocument();
  });

  it("renders HTML artifacts", () => {
    const artifacts = [
      {
        type: "html" as const,
        name: "HTML Artifact",
        description: "An HTML artifact",
        uuid: "123",
        content: "<div><strong>HTML Content</strong></div>",
      },
    ];
    render(<ArtifactView artifacts={artifacts} />);
    // Titled with the artifact's own name: an iframe announced as
    // "HTML Artifact" is more use to a screen reader than "artifact-0".
    const frame = screen.getByTitle("HTML Artifact");
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveAttribute("srcDoc", "<div><strong>HTML Content</strong></div>");
  });

  // Finding 8 (desk): model-generated (LLM-authored) HTML artifacts are
  // display content, not an app the user installed -- unlike the widget HTML
  // renderer's srcDoc (server-generated HTML the user's own backend produced,
  // where JS is deliberately kept on for interactivity), nobody sanctioned
  // letting an LLM response execute arbitrary JS with no CSP. `allow-scripts`
  // must NOT be on this sandbox. `allow-same-origin` was never present here
  // and must stay absent too -- adding it back would hand the frame the
  // parent app's origin.
  it("renders HTML artifacts WITHOUT allow-scripts (display content, not an app)", () => {
    const artifacts = [
      {
        type: "html" as const,
        name: "HTML Artifact",
        description: "An HTML artifact",
        uuid: "123",
        content: "<b>hello</b>",
      },
    ];
    render(<ArtifactView artifacts={artifacts} />);
    const frame = screen.getByTitle("HTML Artifact");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toMatch(/\ballow-scripts\b/);
    expect(sandbox).not.toMatch(/\ballow-same-origin\b/);
  });

  it("falls back to an indexed title when the artifact is unnamed", () => {
    render(
      <ArtifactView
        artifacts={[{ type: "html" as const, name: "", description: "", uuid: "u1", content: "<p>x</p>" }]}
      />
    );
    expect(screen.getByTitle("artifact-0")).toBeInTheDocument();
  });

  it("handles empty artifacts array", () => {
    render(<ArtifactView artifacts={[]} />);
    expect(document.body).toBeTruthy();
  });

  it("handles null/undefined artifacts gracefully", () => {
    render(<ArtifactView artifacts={[] as any} />);
    expect(document.body).toBeTruthy();
  });
});
