import { describe, it, expect } from "vitest";
import {
  BUILTIN_CLOCK_ID,
  CLOCK_LAYOUT_PARAM,
  CLOCK_FACE_PARAM,
  findBuiltin,
} from "./builtins";

describe("Clock built-in", () => {
  it("declares a layout param defaulting to vertical", () => {
    const widget = findBuiltin(BUILTIN_CLOCK_ID)!;
    const layout = widget.params.find((p) => p.paramName === CLOCK_LAYOUT_PARAM)!;
    expect(layout).toBeDefined();
    expect(layout.value).toBe("vertical");
    expect(layout.options).toEqual([
      { label: "Vertical (digital list)", value: "vertical" },
      { label: "Horizontal (analog)", value: "horizontal" },
    ]);
  });

  it("notes on the Typeface param that it only applies to the vertical layout", () => {
    const widget = findBuiltin(BUILTIN_CLOCK_ID)!;
    const face = widget.params.find((p) => p.paramName === CLOCK_FACE_PARAM)!;
    expect(face.description).toMatch(/only applies to the vertical layout/i);
  });
});
