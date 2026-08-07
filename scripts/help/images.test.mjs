import { describe, it, expect } from "vitest";
import { rewriteImagePaths } from "./images.mjs";

describe("rewriteImagePaths", () => {
  it("rewrites a sibling-relative attachment path", () => {
    expect(rewriteImagePaths("![the rail](../attachments/rail-hover.gif)")).toBe(
      "![the rail](./assets/rail-hover.gif)"
    );
  });

  it("rewrites a root-relative attachment path", () => {
    expect(rewriteImagePaths("![a screenshot](attachments/news-window.png)")).toBe(
      "![a screenshot](./assets/news-window.png)"
    );
  });

  it("leaves non-attachment images untouched", () => {
    expect(rewriteImagePaths("![external](https://example.com/x.png)")).toBe(
      "![external](https://example.com/x.png)"
    );
  });
});
