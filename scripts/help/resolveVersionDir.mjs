import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves the exact version folder inside a cloned bdobb-help checkout.
 * Throws if no folder matches the version exactly — no "closest lower
 * version" fallback, so a missing snapshot fails the build instead of
 * silently shipping the wrong version's docs.
 */
export function resolveVersionDir(cacheDir, version) {
  const candidate = join(cacheDir, `v${version}`);
  if (!existsSync(candidate)) {
    throw new Error(
      `[fetch-help-content] no bdobb-help snapshot for v${version} ` +
        `(looked for ${candidate}). Create that folder in the bdobb-help repo before releasing this version.`
    );
  }
  return candidate;
}
