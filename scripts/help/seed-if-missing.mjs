#!/usr/bin/env node
// On a fresh checkout, src/help/generated/ doesn't exist yet -- it's
// gitignored and only ever produced by scripts/fetch-help-content.mjs
// (wired into `pnpm dev` / `pnpm build`). But `pnpm typecheck` and
// `pnpm test`/`test:run` don't run that fetch step, and loadContent.ts
// statically imports ./generated/nav.json and ./generated/search-index.json
// plus globs ./generated/*.md and ./generated/assets/* -- so on a fresh
// clone those fail to resolve before any test or typecheck ever runs.
//
// This script seeds src/help/generated/ from the existing, deterministic,
// network-free test fixture whenever the directory is genuinely absent, so
// typecheck/test can proceed offline. It never touches an already-present
// generated/ (real bundled content from a prior `pnpm dev`/`pnpm build`
// takes priority and is left alone), and fetch-help-content.mjs always
// rmSync's + rebuilds generated/ from scratch on every real run, so this
// fixture content never lingers once a real fetch happens.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { convertVersionFolder } from "./convert.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const outDir = resolve(root, "src/help/generated");
const fixtureDir = resolve(here, "__fixtures__/sample-version");

if (!existsSync(outDir)) {
  convertVersionFolder(fixtureDir, outDir);
  console.log("[seed-if-missing] src/help/generated/ was absent -- seeded from test fixture");
}
