import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  appsJsonToDashboards,
  dashboardsToAppsJson,
  type ImportResult,
  type WidgetResolver,
} from "./appsJson";
import type { Dashboard } from "./types";
import { logError } from "./logger";

/**
 * Tauri glue for the OpenBB Workspace interchange format.
 *
 * The conversion itself lives in appsJson.ts as pure functions so it stays
 * fully testable; this module only picks files and moves bytes.
 */

/** Suggested filename, dated so successive exports do not overwrite silently. */
export function appsJsonFilename(now: string): string {
  return `bdobb-apps-${now.slice(0, 10)}.json`;
}

/**
 * Opens an apps.json and converts it. Returns null when the user cancels,
 * which is a normal outcome rather than a failure.
 *
 * The caller is responsible for showing `unresolved` and `warnings` — the
 * import is only trustworthy if the user learns which widgets did not survive.
 */
export async function importAppsJson(resolve: WidgetResolver): Promise<ImportResult | null> {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "OpenBB app", extensions: ["json"] }],
  });
  if (!path || typeof path !== "string") return null;

  let text: string;
  try {
    // No baseDir: the dialog returns an absolute path and extends the fs scope
    // to the file the user picked.
    text = await readTextFile(path);
  } catch (e) {
    logError(`apps.json import: failed to read ${path}: ${String(e)}`);
    throw new Error(`Could not read ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // Distinguish a bad file from a bad conversion: the user picked this, and
    // "not valid JSON" is something they can act on.
    throw new Error(`${path} is not valid JSON: ${String(e)}`);
  }

  return appsJsonToDashboards(raw, resolve);
}

/**
 * Writes dashboards out as an apps.json. Returns the path, or null if the user
 * cancelled.
 */
export async function exportAppsJson(
  dashboards: Dashboard[],
  opts: { exportedAt: string; name?: string } = { exportedAt: new Date().toISOString() }
): Promise<string | null> {
  const doc = dashboardsToAppsJson(dashboards, { name: opts.name });

  const path = await save({
    defaultPath: appsJsonFilename(opts.exportedAt),
    filters: [{ name: "OpenBB app", extensions: ["json"] }],
  });
  if (!path) return null;

  try {
    await writeTextFile(path, `${JSON.stringify(doc, null, 2)}\n`);
    return path;
  } catch (e) {
    logError(`apps.json export: failed to write ${path}: ${String(e)}`);
    throw e;
  }
}
