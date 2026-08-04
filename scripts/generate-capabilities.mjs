#!/usr/bin/env node
/**
 * Generates src-tauri/capabilities/default.json from
 * src-tauri/capability.template.json.
 *
 * The HTTP scope is static in the template and open to any http(s) host:
 * BDOBB is a generic front end, and which backends it talks to is the
 * user's runtime choice (the Backends dialog), not a build-time property.
 *
 * Tauri capabilities are compiled into the binary and support no environment
 * interpolation, so the file has to exist on disk before cargo builds. The
 * generated file is gitignored; the template is what is committed. The
 * template lives OUTSIDE src-tauri/capabilities/ because Tauri parses every
 * .json in that directory as a capability, and shipping both would double
 * the grants. Runs from `pnpm dev` and `pnpm build`, which tauri.conf.json
 * invokes as beforeDevCommand / beforeBuildCommand.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(root, "src-tauri/capability.template.json");
const outPath = resolve(root, "src-tauri/capabilities/default.json");

const cap = JSON.parse(readFileSync(templatePath, "utf8"));
// The template sits one level above capabilities/, so its $schema is relative
// to src-tauri; the generated file needs the path from inside capabilities/.
if (typeof cap.$schema === "string") {
  cap.$schema = cap.$schema.replace(/^\.\//, "../");
}
cap.description =
  "BDOBB main window: HTTP to any host + $APPDATA fs. GENERATED — edit src-tauri/capability.template.json, not this file.";

// default.json is the only file in capabilities/ and it is gitignored, so git
// does not track the directory and a fresh clone does not have it. Without
// this, the first `pnpm dev` or `pnpm build` after cloning fails on ENOENT.
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(cap, null, 2) + "\n");
console.log("[capabilities] wrote default.json (open http scope)");
