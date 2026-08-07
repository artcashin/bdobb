#!/usr/bin/env node
// Fetches the bdobb-help content repo, resolves the version folder matching
// this package's own version, and converts it into src/help/generated/ for
// Vite to bundle. Wired into `pnpm dev` / `pnpm build`, same pattern as
// generate-capabilities.mjs.
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveVersionDir } from "./help/resolveVersionDir.mjs";
import { convertVersionFolder } from "./help/convert.mjs";
import { fetchRepo } from "./help/fetchRepo.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const version = pkg.version;

const REPO_URL = "https://github.com/artcashin/bdobb-help.git";
const cacheDir = resolve(root, ".help-cache");
const outDir = resolve(root, "src/help/generated");

fetchRepo(cacheDir, REPO_URL);

const versionDir = resolveVersionDir(cacheDir, version);

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

convertVersionFolder(versionDir, outDir);

console.log(`[fetch-help-content] bundled help content for v${version} from ${versionDir}`);
