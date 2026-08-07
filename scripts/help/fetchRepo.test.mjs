import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchRepo } from "./fetchRepo.mjs";

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("fetchRepo", () => {
  let workDir;
  let originDir;
  let cacheDir;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "bdobb-fetchrepo-test-"));
    originDir = join(workDir, "origin");
    cacheDir = join(workDir, "cache");

    // A real local git repo standing in for the bdobb-help GitHub remote --
    // no network involved anywhere in this test.
    git(["init", "--quiet", "-b", "main", originDir]);
    git(["config", "user.email", "test@example.com"], originDir);
    git(["config", "user.name", "Test"], originDir);
    writeFileSync(join(originDir, "v1-marker.txt"), "first\n");
    git(["add", "."], originDir);
    git(["commit", "--quiet", "-m", "first"], originDir);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("clones the repo when no cache exists yet", () => {
    fetchRepo(cacheDir, originDir);
    expect(existsSync(join(cacheDir, ".git"))).toBe(true);
    expect(existsSync(join(cacheDir, "v1-marker.txt"))).toBe(true);
  });

  it("pulls new commits into an existing cache", () => {
    writeFileSync(join(originDir, "v2-marker.txt"), "second\n");
    git(["add", "."], originDir);
    git(["commit", "--quiet", "-m", "second"], originDir);

    fetchRepo(cacheDir, originDir);
    expect(existsSync(join(cacheDir, "v2-marker.txt"))).toBe(true);
  });

  it("falls back to the cached checkout instead of throwing when the fetch fails", () => {
    // Simulate offline/flaky-VPN/GitHub-incident conditions: the cached
    // checkout exists, but the remote it points at can never resolve.
    git(["remote", "set-url", "origin", "/nonexistent/bdobb-help-origin"], cacheDir);

    expect(() => fetchRepo(cacheDir, "/nonexistent/bdobb-help-origin")).not.toThrow();
    // Content from the last successful fetch is still there, untouched.
    expect(existsSync(join(cacheDir, "v2-marker.txt"))).toBe(true);
  });

  it("still throws on a genuinely first clone with no cache to fall back to", () => {
    const freshCacheDir = join(workDir, "fresh-cache-no-fallback");
    expect(() => fetchRepo(freshCacheDir, "/nonexistent/bdobb-help-origin")).toThrow();
  });
});
