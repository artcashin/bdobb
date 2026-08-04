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

function run(env: Record<string, string>) {
  execFileSync("node", [SCRIPT], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  return JSON.parse(readFileSync(OUT, "utf8"));
}

function permission(cap: any, identifier: string) {
  return cap.permissions.find(
    (p: unknown) => typeof p === "object" && p !== null && (p as any).identifier === identifier
  );
}

const BASE = {
  VITE_OPENBB_API_URL: "https://api.example.test",
};

afterAll(() => {
  // Restore the developer's real capability file; the tests above overwrote it.
  execFileSync("node", [SCRIPT], { stdio: "pipe" });
});

describe("generate-capabilities", () => {
  it("scopes HTTP to the configured origins, with a wildcard-port variant", () => {
    const http = permission(run(BASE), "http:default");
    const urls = http.allow.map((a: { url: string }) => a.url);
    expect(urls).toContain("https://api.example.test/*");
    // Serve can publish extra ports on the same host, so an any-port rule too.
    expect(urls).toContain("https://api.example.test:*/*");
  });

  it("falls back to a tailnet wildcard when nothing is configured", () => {
    const http = permission(
      run({ VITE_OPENBB_API_URL: "" }),
      "http:default"
    );
    expect(http.allow.map((a: { url: string }) => a.url)).toEqual([
      "https://*.ts.net/*",
      "https://*.ts.net:*/*",
    ]);
  });

  it("keeps $APPDATA in the fs scope", () => {
    const fs = permission(run(BASE), "fs:scope");
    expect(fs.allow.map((a: { path: string }) => a.path)).toEqual(["$APPDATA", "$APPDATA/**"]);
  });

  it("preserves the permissions the template declares", () => {
    const cap = run(BASE);
    // A dropped fs verb or the dialog permission would break export silently.
    expect(cap.permissions).toContain("fs:allow-write-text-file");
    expect(cap.permissions).toContain("fs:allow-mkdir");
    expect(cap.permissions).toContain("dialog:allow-save");
    expect(cap.identifier).toBe("default");
  });
});
