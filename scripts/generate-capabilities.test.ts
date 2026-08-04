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
  VITE_RITA_URL: "https://rita.example.test",
  VITE_MCP_SERVERS: "a=https://api.example.test:8443/mcp",
  VITE_SHARE_FOLDERS: "",
};

afterAll(() => {
  // Restore the developer's real capability file; the tests above overwrote it.
  execFileSync("node", [SCRIPT], { stdio: "pipe" });
});

describe("generate-capabilities", () => {
  it("keeps the HTTP scope open to any http(s) host, regardless of env", () => {
    // BDOBB is a generic front end: backends are a runtime choice, so the
    // scope must not narrow to whatever happens to be in the environment.
    const http = permission(run(BASE), "http:default");
    expect(http.allow.map((a: { url: string }) => a.url)).toEqual([
      "http://*/*",
      "http://*:*/*",
      "https://*/*",
      "https://*:*/*",
    ]);
  });

  it("keeps $APPDATA in the fs scope when no share folder is set", () => {
    const fs = permission(run(BASE), "fs:scope");
    expect(fs.allow.map((a: { path: string }) => a.path)).toEqual(["$APPDATA", "$APPDATA/**"]);
  });

  it("adds a share folder and its contents to the fs scope", () => {
    // Without this a `file` share target is refused in a packaged build.
    const fs = permission(
      run({ ...BASE, VITE_SHARE_FOLDERS: "/Users/x/Vault/Notes" }),
      "fs:scope"
    );
    const paths = fs.allow.map((a: { path: string }) => a.path);
    expect(paths).toContain("/Users/x/Vault/Notes");
    expect(paths).toContain("/Users/x/Vault/Notes/**");
    expect(paths).toContain("$APPDATA");
  });

  it("accepts several folders and strips trailing slashes", () => {
    const fs = permission(
      run({ ...BASE, VITE_SHARE_FOLDERS: "/a/one/, /b/two" }),
      "fs:scope"
    );
    const paths = fs.allow.map((a: { path: string }) => a.path);
    expect(paths).toContain("/a/one");
    expect(paths).toContain("/a/one/**");
    expect(paths).toContain("/b/two");
    expect(paths).not.toContain("/a/one/");
  });

  it("ignores a non-absolute folder rather than emitting a broken rule", () => {
    const fs = permission(
      run({ ...BASE, VITE_SHARE_FOLDERS: "relative/path" }),
      "fs:scope"
    );
    expect(fs.allow.map((a: { path: string }) => a.path)).toEqual(["$APPDATA", "$APPDATA/**"]);
  });

  it("does not duplicate a folder already in scope", () => {
    const fs = permission(
      run({ ...BASE, VITE_SHARE_FOLDERS: "/a/one,/a/one" }),
      "fs:scope"
    );
    const paths = fs.allow.map((a: { path: string }) => a.path);
    expect(paths.filter((p: string) => p === "/a/one")).toHaveLength(1);
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
