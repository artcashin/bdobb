import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs with jsdom", () => {
    const el = document.createElement("div");
    el.textContent = "bdobb";
    expect(el).toHaveTextContent("bdobb");
  });
});
