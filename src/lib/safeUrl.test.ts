import { describe, expect, it } from "vitest";
import { safeUrl, isSafeUrl, isHttpUrl } from "./safeUrl";

describe("safeUrl", () => {
  it("passes through the schemes citations and widget endpoints actually use", () => {
    expect(safeUrl("https://api.example/widgets")).toBe("https://api.example/widgets");
    expect(safeUrl("http://localhost:6900/x")).toBe("http://localhost:6900/x");
    expect(safeUrl("mailto:desk@example.com")).toBe("mailto:desk@example.com");
  });

  it("rejects javascript: however it is dressed up", () => {
    // A startsWith("javascript:") check misses every one of these; the URL
    // parser normalizes whitespace and case away before the scheme is read.
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\nscript:alert(1)",
      "\tjavascript:alert(1)",
    ]) {
      expect(safeUrl(hostile)).toBeNull();
    }
  });

  it("rejects data: and file:", () => {
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects relative and empty values", () => {
    // A relative iframe src resolves against the app itself, framing the app
    // inside its own window rather than the intended widget.
    expect(safeUrl("/widgets/chart")).toBeNull();
    expect(safeUrl("")).toBeNull();
    expect(safeUrl("   ")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl({ url: "https://example" })).toBeNull();
  });

  it("isSafeUrl agrees with safeUrl", () => {
    expect(isSafeUrl("https://example")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
  });
});

// Migrated from desk's url.test.ts (Task 8 merge: desk's `isHttpUrl` in
// url.ts survives here as safeUrl.ts's `isHttpUrl`, ported verbatim — see
// docs/MERGE-NOTES.md).
describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://openbb.example.ts.net")).toBe(true);
    expect(isHttpUrl("http://agent-host.example:8002")).toBe(true);
  });

  it("rejects javascript: and file: schemes even though they parse as valid URLs (Minor)", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects unparseable strings", () => {
    expect(isHttpUrl("hello")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  // Not in desk's url.test.ts: added here to document the one behavioral
  // difference from isSafeUrl, which allows mailto: for citation links.
  it("rejects mailto:, unlike isSafeUrl", () => {
    expect(isHttpUrl("mailto:desk@example.com")).toBe(false);
    expect(isSafeUrl("mailto:desk@example.com")).toBe(true);
  });
});
