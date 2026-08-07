import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Clones (first run) or updates (subsequent runs) a git checkout of
 * repoUrl into cacheDir.
 *
 * When a cached checkout already exists, a fetch failure (offline, flaky
 * VPN, a GitHub incident) is swallowed with a warning instead of thrown, so
 * `pnpm dev`/`pnpm build` can fall back to whatever's already cached rather
 * than hard-failing a command that doesn't actually need fresh content. The
 * first-ever clone has no cached copy to fall back to, so that path still
 * fails loudly -- there's nothing to build the Help window from otherwise.
 */
export function fetchRepo(cacheDir, repoUrl) {
  if (existsSync(resolve(cacheDir, ".git"))) {
    try {
      execFileSync("git", ["-C", cacheDir, "fetch", "origin", "--quiet"], { stdio: "inherit" });
      execFileSync("git", ["-C", cacheDir, "reset", "--hard", "origin/main", "--quiet"], {
        stdio: "inherit",
      });
    } catch {
      console.warn(
        "[fetch-help-content] warning: could not fetch latest bdobb-help content, using cached copy"
      );
    }
  } else {
    mkdirSync(cacheDir, { recursive: true });
    execFileSync("git", ["clone", "--quiet", repoUrl, cacheDir], { stdio: "inherit" });
  }
}
