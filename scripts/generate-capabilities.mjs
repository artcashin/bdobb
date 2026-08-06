#!/usr/bin/env node
/**
 * Generates src-tauri/capabilities/default.json from
 * src-tauri/capability.template.json.
 *
 * The HTTP scope is static in the template and open to any http(s) host:
 * BDOBB is a generic front end, and which backends it talks to is the
 * user's runtime choice (Backends and Settings dialogs), not a build-time
 * property. What this script adds is the machine-local part: extra fs:scope
 * entries for the folders a `file` share target may write into
 * (VITE_SHARE_FOLDERS, comma-separated absolute paths, from .env.local or
 * the environment).
 *
 * Tauri capabilities are compiled into the binary and support no environment
 * interpolation, so the file has to exist on disk before cargo builds. The
 * generated file is gitignored; the template is what is committed. The
 * template lives OUTSIDE src-tauri/capabilities/ because Tauri parses every
 * .json in that directory as a capability, and shipping both would double
 * the grants. Runs from `pnpm dev` and `pnpm build`, which tauri.conf.json
 * invokes as beforeDevCommand / beforeBuildCommand.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(root, "src-tauri/capability.template.json");
const outPath = resolve(root, "src-tauri/capabilities/default.json");

/** Minimal .env parser — avoids a dependency for one variable. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = { ...readEnvFile(resolve(root, ".env.local")), ...process.env };

/**
 * Folders a `file` share target may write into. These sit outside $APPDATA, so
 * without an fs:scope entry the write is refused — and only in a packaged
 * build, since dev is more permissive. Comma-separated absolute paths.
 */
const shareFolders = (env.VITE_SHARE_FOLDERS ?? "")
  .split(",")
  .map((f) => f.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const cap = JSON.parse(readFileSync(templatePath, "utf8"));
// The template sits one level above capabilities/, so its $schema is relative
// to src-tauri; the generated file needs the path from inside capabilities/.
if (typeof cap.$schema === "string") {
  cap.$schema = cap.$schema.replace(/^\.\//, "../");
}
for (const perm of cap.permissions) {
  if (!perm || typeof perm !== "object") continue;

  if (perm.identifier === "fs:scope") {
    const existing = new Set(perm.allow.map((a) => a.path));
    for (const folder of shareFolders) {
      if (!folder.startsWith("/")) {
        console.warn(`[capabilities] skipping non-absolute share folder: ${folder}`);
        continue;
      }
      // The folder itself and its contents: writing a note needs the file
      // entry, and a nested template path needs to create subdirectories.
      for (const path of [folder, `${folder}/**`]) {
        if (!existing.has(path)) {
          existing.add(path);
          perm.allow.push({ path });
        }
      }
    }
  }
}
cap.description =
  "BDOBB main window: HTTP to any host + $APPDATA fs. GENERATED — edit src-tauri/capability.template.json, not this file.";

// default.json is the only file in capabilities/ and it is gitignored, so git
// does not track the directory and a fresh clone does not have it. Without
// this, the first `pnpm dev` or `pnpm build` after cloning fails on ENOENT.
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(cap, null, 2) + "\n");
console.log(
  "[capabilities] wrote default.json (open http scope)" +
    (shareFolders.length ? ` with ${shareFolders.length} share folder(s)` : "")
);
