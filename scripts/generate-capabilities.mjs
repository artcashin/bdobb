#!/usr/bin/env node
/**
 * Generates src-tauri/capabilities/default.json from
 * src-tauri/capability.template.json, scoping the HTTP allowlist to the
 * endpoints in .env.local.
 *
 * The template deliberately lives OUTSIDE src-tauri/capabilities/: Tauri parses
 * every .json in that directory as a capability, and the __HTTP_ALLOW__
 * placeholder is a string where it expects an array, so keeping the template
 * there fails the cargo build before any Rust compiles.
 *
 * Tauri capabilities are compiled into the binary and support no environment
 * interpolation, so the file has to exist on disk before cargo builds. It is
 * gitignored precisely because it names real hosts — the template is what is
 * committed. Runs from `pnpm dev` and `pnpm build`, which tauri.conf.json
 * invokes as beforeDevCommand / beforeBuildCommand.
 *
 * Falls back to https://*.ts.net/* when nothing is configured, so a fresh
 * clone still builds; that is broader than a real deployment needs, and the
 * warning below says so. Pass --strict to make that case a build failure
 * instead — the release workflow does, so a shipped binary can never carry the
 * wildcard by accident.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = resolve(root, "src-tauri/capability.template.json");
const outPath = resolve(root, "src-tauri/capabilities/default.json");

/** Minimal .env parser — avoids a dependency for three variables. */
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

const urls = [
  env.VITE_OPENBB_API_URL,
  env.VITE_RITA_URL,
  ...(env.VITE_MCP_SERVERS ?? "")
    .split(",")
    .map((e) => e.slice(e.indexOf("=") + 1).trim())
    .filter(Boolean),
].filter(Boolean);

/** origin → two rules: the origin itself and any port on that host. */
const allow = [];
const seen = new Set();
for (const raw of urls) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.warn(`[capabilities] skipping unparseable URL: ${raw}`);
    continue;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    console.warn(`[capabilities] skipping non-http(s) URL: ${raw}`);
    continue;
  }
  for (const pattern of [
    `${u.protocol}//${u.hostname}/*`,
    `${u.protocol}//${u.hostname}:*/*`,
  ]) {
    if (!seen.has(pattern)) {
      seen.add(pattern);
      allow.push({ url: pattern });
    }
  }
}

/**
 * The wildcard fallback below is a development convenience: it lets a fresh
 * clone run without configuration. Shipping it is another matter — a released
 * binary carrying https://*.ts.net/* can reach every host on any tailnet its
 * user joins, which is far more than the app needs and not something a release
 * should decide silently. --strict turns the fallback into a build failure, and
 * the release workflow passes it.
 */
const strict = process.argv.includes("--strict");

if (allow.length === 0) {
  if (strict) {
    console.error(
      "[capabilities] refusing to build: no endpoints configured.\n" +
        "  --strict was passed, so the https://*.ts.net/* fallback is not applied.\n" +
        "  Set VITE_OPENBB_API_URL, VITE_RITA_URL and VITE_MCP_SERVERS (repository\n" +
        "  variables in CI, .env.local locally) so the HTTP capability is scoped to\n" +
        "  the hosts this build actually talks to."
    );
    process.exit(1);
  }
  console.warn(
    "[capabilities] no endpoints in .env.local — falling back to https://*.ts.net/*.\n" +
      "                Copy .env.example to .env.local to scope this to your own hosts."
  );
  allow.push({ url: "https://*.ts.net/*" }, { url: "https://*.ts.net:*/*" });
}

const cap = JSON.parse(readFileSync(templatePath, "utf8"));
// The template sits one level above capabilities/, so its $schema is relative
// to src-tauri; the generated file needs the path from inside capabilities/.
if (typeof cap.$schema === "string") {
  cap.$schema = cap.$schema.replace(/^\.\//, "../");
}
for (const perm of cap.permissions) {
  if (!perm || typeof perm !== "object") continue;

  if (perm.identifier === "http:default") {
    perm.allow = allow;
  }

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
  "BDOBB main window: HTTP to configured endpoints + $APPDATA fs. GENERATED — edit src-tauri/capability.template.json, not this file.";

// default.json is the only file in capabilities/ and it is gitignored, so git
// does not track the directory and a fresh clone does not have it. Without
// this, the first `pnpm dev` or `pnpm build` after cloning fails on ENOENT.
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(cap, null, 2) + "\n");
console.log(
  `[capabilities] wrote ${allow.length} HTTP allow rules` +
    (shareFolders.length ? ` and ${shareFolders.length} share folder(s)` : "") +
    " to default.json"
);
