import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AnalogFace from "./AnalogFace";

describe("AnalogFace", () => {
  it("points the hour hand to the hour-plus-fraction angle", () => {
    // 15:30 -> hour%12 = 3, +30/60 = 3.5 -> 3.5 * 30 = 105deg.
    const { container } = render(<AnalogFace hour={15} minute={30} />);
    expect(container.querySelector(".analog-hand-hour")).toHaveAttribute(
      "transform",
      "rotate(105 50 50)"
    );
  });

  it("points the minute hand to minute * 6 degrees", () => {
    const { container } = render(<AnalogFace hour={15} minute={30} />);
    expect(container.querySelector(".analog-hand-minute")).toHaveAttribute(
      "transform",
      "rotate(180 50 50)"
    );
  });

  it("treats a 24-hour value the same as its 12-hour equivalent", () => {
    // 15:00 and 3:00 must point the hour hand identically.
    const { container: c24 } = render(<AnalogFace hour={15} minute={0} />);
    const { container: c12 } = render(<AnalogFace hour={3} minute={0} />);
    expect(c24.querySelector(".analog-hand-hour")).toHaveAttribute(
      "transform",
      c12.querySelector(".analog-hand-hour")!.getAttribute("transform")!
    );
  });

  it("draws 12 unmarked batons and no numerals", () => {
    const { container } = render(<AnalogFace hour={0} minute={0} />);
    expect(container.querySelectorAll("rect")).toHaveLength(14); // 12 batons + 2 hands
    expect(container.querySelector("text")).toBeNull();
  });

  it("draws no second hand", () => {
    const { container } = render(<AnalogFace hour={0} minute={0} />);
    expect(container.querySelector('[class*="second"]')).toBeNull();
  });

  it("is aria-hidden, since the tile around it carries the spoken time", () => {
    const { container } = render(<AnalogFace hour={0} minute={0} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
