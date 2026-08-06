import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import AppearanceTab from "./AppearanceTab";
import { DEFAULT_SETTINGS } from "../../../lib/persistence";

describe("AppearanceTab", () => {
  it("renders theme section with dark only", () => {
    render(<AppearanceTab settings={DEFAULT_SETTINGS} />);
    // "Appearance" now also labels the tab button, so scope to the section heading.
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Dark (v1)")).toBeInTheDocument();
  });
});
