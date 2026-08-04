import { describe, expect, it, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The capability file is compiled into the binary, so a mistake here surfaces
 * only in a packaged build — as a refused request or a refused write, with no
 * failing test anywhere. These run the real script.
 */
const SCRIPT = "scripts/generate-capabilities.mjs";
const OUT = "src-tauri/capabilities/default.json";

function run() {
  execFileSync("node", [SCRIPT], { stdio: "pipe" });
  return JSON.parse(readFileSync(OUT, "utf8"));
}

function permission(cap: any, identifier: string) {
  return cap.permissions.find(
    (p: unknown) => typeof p === "object" && p !== null && (p as any).identifier === identifier
  );
}

afterAll(() => {
  // Restore the developer's real capability file; the tests above overwrote it.
  execFileSync("node", [SCRIPT], { stdio: "pipe" });
});

describe("generate-capabilities", () => {
  it("keeps the HTTP scope open to any http(s) host", () => {
    // BDOBB is a generic front end: backends are a runtime choice, so the
    // scope must not narrow to build-time configuration.
    const http = permission(run(), "http:default");
    expect(http.allow.map((a: { url: string }) => a.url)).toEqual([
      "http://*/*",
      "http://*:*/*",
      "https://*/*",
      "https://*:*/*",
    ]);
  });

  it("keeps $APPDATA in the fs scope", () => {
    const fs = permission(run(), "fs:scope");
    expect(fs.allow.map((a: { path: string }) => a.path)).toEqual(["$APPDATA", "$APPDATA/**"]);
  });

  it("preserves the permissions the template declares", () => {
    const cap = run();
    // A dropped fs verb or the dialog permission would break export silently.
    expect(cap.permissions).toContain("fs:allow-write-text-file");
    expect(cap.permissions).toContain("fs:allow-mkdir");
    expect(cap.permissions).toContain("dialog:allow-save");
    expect(cap.identifier).toBe("default");
  });
});
