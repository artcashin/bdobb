import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVersionDir } from "./resolveVersionDir.mjs";

describe("resolveVersionDir", () => {
  it("returns the path when an exact version folder exists", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bdobb-help-test-"));
    mkdirSync(join(cacheDir, "v9.0.0"));
    try {
      expect(resolveVersionDir(cacheDir, "9.0.0")).toBe(join(cacheDir, "v9.0.0"));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("throws when no folder matches the version exactly", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bdobb-help-test-"));
    mkdirSync(join(cacheDir, "v8.0.0"));
    try {
      expect(() => resolveVersionDir(cacheDir, "9.0.0")).toThrow(
        /no bdobb-help snapshot for v9\.0\.0/
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
