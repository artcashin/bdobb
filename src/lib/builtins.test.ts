import { describe, expect, it } from "vitest";
import {
  BUILTIN_BACKEND_ID,
  BUILTIN_SYMPHONY_ID,
  SYMPHONY_POD_URL_PARAM,
  SYMPHONY_STREAM_ID_PARAM,
  SYMPHONY_MODE_PARAM,
  SYMPHONY_THEME_PARAM,
  BUILTIN_CLOCK_ID,
  CLOCK_LAYOUT_PARAM,
  CLOCK_FACE_PARAM,
  findBuiltin,
} from "./builtins";

describe("Symphony built-in", () => {
  it("has the reserved id", () => {
    expect(BUILTIN_SYMPHONY_ID).toBe("builtin:symphony");
  });

  it("is registered under the builtin backend", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID);
    expect(widget).toBeDefined();
    expect(widget!.backendId).toBe(BUILTIN_BACKEND_ID);
  });

  it("declares exactly the four params: podUrl, streamId, mode, theme", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID)!;
    const names = widget.params.map((p) => p.paramName).sort();
    expect(names).toEqual(
      [SYMPHONY_POD_URL_PARAM, SYMPHONY_STREAM_ID_PARAM, SYMPHONY_MODE_PARAM, SYMPHONY_THEME_PARAM].sort()
    );
  });

  it("does not declare a partnerId param (that's an app-level setting, not a widget param)", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID)!;
    expect(widget.params.find((p) => p.paramName === "partnerId")).toBeUndefined();
  });

  it("defaults mode to 'focus'", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID)!;
    const mode = widget.params.find((p) => p.paramName === SYMPHONY_MODE_PARAM)!;
    expect(mode.value).toBe("focus");
  });

  it("defaults theme to 'dark'", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID)!;
    const theme = widget.params.find((p) => p.paramName === SYMPHONY_THEME_PARAM)!;
    expect(theme.value).toBe("dark");
  });

  it("declares podUrl and streamId as plain params with no baked-in default", () => {
    const widget = findBuiltin(BUILTIN_SYMPHONY_ID)!;
    const podUrl = widget.params.find((p) => p.paramName === SYMPHONY_POD_URL_PARAM)!;
    const streamId = widget.params.find((p) => p.paramName === SYMPHONY_STREAM_ID_PARAM)!;
    expect(podUrl.value).toBe("");
    expect(streamId.value).toBe("");
  });
});

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
