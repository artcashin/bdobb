import {
  BaseDirectory, exists, mkdir, readDir, readTextFile, remove, rename, writeTextFile,
} from "@tauri-apps/plugin-fs";
import { logError } from "./logger";
import type { BackendConfig, Dashboard, Settings } from "./types";
import { newId } from "./uuid";
import { DEFAULT_API_URL, DEFAULT_RITA_URL, DEFAULT_MCP_SERVERS } from "./config";

export type { BackendConfig, Dashboard, Settings };

const BASE = { baseDir: BaseDirectory.AppData };

let loadDashboardsPromise: Promise<Dashboard[]> | null = null;

/**
 * The only settings defaults in the app. settingsStore and SettingsDialog each
 * carried their own copy, and both were wrong in the same way: ritaUrl "" and
 * mcpServers [] rather than the configured values. Saving from a dialog opened
 * before load() finished therefore persisted the empty ones over the real
 * configuration.
 */
export const DEFAULT_SETTINGS: Settings = {
  ritaUrl: DEFAULT_RITA_URL,
  theme: "dark",
  contextSharing: false,
  mcpServers: DEFAULT_MCP_SERVERS,
  symphonyPodUrl: "",
  symphonyPartnerId: "",
  symphonyBridgeUrl: "",
  symphonyDisplayName: "",
};

export const DEFAULT_BACKENDS: BackendConfig[] = [
  { id: "nas", name: "OpenBB API", baseUrl: DEFAULT_API_URL },
];

async function ensureDirs(): Promise<void> {
  try {
    await mkdir("dashboards", { ...BASE, recursive: true });
    await mkdir("logs", { ...BASE, recursive: true });
  } catch (e) {
    logError(`persistence: failed to create app-data directories: ${String(e)}`);
    throw e;
  }
}

/**
 * Renames an unreadable/unparseable/wrong-shape file out of the way instead
 * of leaving it to be silently clobbered by the next default-seeding write.
 * Never clobbers a pre-existing `.corrupt` file (which may hold the user's
 * real config from an earlier corruption) — a second corruption gets a
 * numeric suffix instead.
 */
async function quarantine(path: string): Promise<void> {
  try {
    let corruptPath = `${path}.corrupt`;
    if (await exists(corruptPath, BASE)) {
      let n = 1;
      while (await exists(`${corruptPath}.${n}`, BASE)) n++;
      corruptPath = `${corruptPath}.${n}`;
    }
    await rename(path, corruptPath, {
      oldPathBaseDir: BASE.baseDir,
      newPathBaseDir: BASE.baseDir,
    });
  } catch (e) {
    logError(`persistence: failed to quarantine ${path}: ${String(e)}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isMcpServerConfig(v: unknown): v is Settings["mcpServers"][number] {
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.url === "string" &&
    typeof v.enabled === "boolean"
  );
}

/**
 * desk finding 4 (path b): this used to be `isPlainObject(v)` only —
 * container-level, not field-level. `{"mcpServers":"hello"}` parses to a
 * plain object and survived straight into the merge with DEFAULT_SETTINGS,
 * so `settings.mcpServers` ended up a string and SettingsDialog's
 * `settings.mcpServers.map(...)` threw. Every KNOWN field is now checked
 * when present (all optional, since a partial override — e.g. just
 * `{"ritaUrl": "..."}` — is the normal, valid case handled by the
 * DEFAULT_SETTINGS merge in `loadSettings`); unrecognized extra keys
 * (including qwen-only ones like `shareTargets`) are still allowed through
 * unchanged, same tolerance as before.
 */
function isSettingsShape(v: unknown): v is Partial<Settings> {
  if (!isPlainObject(v)) return false;
  if ("ritaUrl" in v && typeof v.ritaUrl !== "string") return false;
  if ("theme" in v && v.theme !== "dark") return false;
  if ("contextSharing" in v && typeof v.contextSharing !== "boolean") return false;
  if ("mcpServers" in v) {
    if (!Array.isArray(v.mcpServers)) return false;
    if (!v.mcpServers.every(isMcpServerConfig)) return false;
  }
  if ("symphonyPodUrl" in v && typeof v.symphonyPodUrl !== "string") return false;
  if ("symphonyPartnerId" in v && typeof v.symphonyPartnerId !== "string") return false;
  if ("symphonyBridgeUrl" in v && typeof v.symphonyBridgeUrl !== "string") return false;
  if ("symphonyDisplayName" in v && typeof v.symphonyDisplayName !== "string") return false;
  return true;
}

function isBackendConfig(v: unknown): v is BackendConfig {
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.baseUrl === "string" &&
    (v.headerName === undefined || typeof v.headerName === "string") &&
    (v.headerValue === undefined || typeof v.headerValue === "string")
  );
}

/**
 * desk finding 4 (path b): this used to be `Array.isArray(v)` only — an
 * array of anything (`[null]`, `[{}]`, `[{"id":"nas"}]`) passed. BackendsDialog's
 * render reads `b.id`, `b.name`, `b.baseUrl` unconditionally per entry, so a
 * malformed one broke it. Every entry is now checked individually; one bad
 * entry quarantines the whole file (same all-or-nothing policy as the
 * existing corrupt/wrong-shape cases) rather than silently dropping just
 * that entry, which would look like a mystery data loss instead of an
 * explained quarantine.
 */
function isBackendsShape(v: unknown): v is BackendConfig[] {
  return Array.isArray(v) && v.every(isBackendConfig);
}

function isDashboardShape(v: unknown): v is Dashboard {
  // `name` is validated because loadDashboards sorts on it with localeCompare;
  // a file missing it would otherwise fail the whole shell instead of being quarantined.
  return (
    isPlainObject(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    Array.isArray(v.cards)
  );
}

/**
 * Reads and parses a JSON file, distinguishing "file absent" (null, normal
 * first run, seeds silently) from "file present but unusable" — unreadable,
 * unparseable, OR parses fine but fails the caller's shape check (e.g. valid
 * JSON `null`, or an object where an array was expected). The latter case is
 * also null, but logged and the bad file preserved as `<path>.corrupt`
 * instead of being silently overwritten by the caller's default-seeding
 * logic.
 */
async function readJsonFile<T>(
  path: string,
  isValidShape: (v: unknown) => v is T,
): Promise<T | null> {
  if (!(await exists(path, BASE))) return null;
  let text: string;
  try {
    text = await readTextFile(path, BASE);
  } catch (e) {
    logError(`persistence: failed to read ${path}: ${String(e)}`);
    await quarantine(path);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    logError(`persistence: failed to parse ${path}: ${String(e)}`);
    await quarantine(path);
    return null;
  }
  if (!isValidShape(parsed)) {
    logError(`persistence: ${path} has an unexpected shape; quarantining`);
    await quarantine(path);
    return null;
  }
  return parsed;
}

/**
 * One in-flight write per path. Two writers to the same file previously raced:
 * `Date.now()` gave them the same temp name, the first rename won, and the
 * others rejected with ENOENT having silently dropped their content.
 */
const writeChains = new Map<string, Promise<void>>();
let tempCounter = 0;

function writeJsonFile(path: string, value: unknown): Promise<void> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => writeJsonFileNow(path, value));
  writeChains.set(path, next.catch(() => {}));
  return next;
}

async function writeJsonFileNow(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp.${Date.now()}.${tempCounter++}`;
  try {
    await writeTextFile(tempPath, JSON.stringify(value, null, 2), BASE);
    await rename(tempPath, path, { oldPathBaseDir: BASE.baseDir, newPathBaseDir: BASE.baseDir });
  } catch (e) {
    logError(`persistence: failed to write ${path}: ${String(e)}`);
    await remove(tempPath, BASE).catch(() => {});
    throw e;
  }
}

export async function init(): Promise<void> {
  await ensureDirs();
}

export async function loadSettings(): Promise<Settings> {
  await ensureDirs();
  const s = await readJsonFile<Partial<Settings>>("settings.json", isSettingsShape);
  if (s === null) {
    await writeJsonFile("settings.json", DEFAULT_SETTINGS);
    return structuredClone(DEFAULT_SETTINGS);
  }
  return { ...structuredClone(DEFAULT_SETTINGS), ...s } as Settings;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ensureDirs();
  await writeJsonFile("settings.json", settings);
}

export async function loadBackends(): Promise<BackendConfig[]> {
  await ensureDirs();
  const b = await readJsonFile<BackendConfig[]>("backends.json", isBackendsShape);
  if (b === null || b.length === 0) {
    await writeJsonFile("backends.json", DEFAULT_BACKENDS);
    return structuredClone(DEFAULT_BACKENDS);
  }
  return b;
}

export async function saveBackends(backends: BackendConfig[]): Promise<void> {
  await ensureDirs();
  await writeJsonFile("backends.json", backends);
}

/**
 * The chat transcript, so a conversation outlives the process. Kept separate
 * from settings: it is append-heavy, user content rather than configuration,
 * and a corrupt transcript must not take the app's settings down with it.
 */
const CHAT_FILE = "chat.json";

function isChatShape(v: unknown): v is { messages: unknown[]; calls: unknown[] } {
  return isPlainObject(v) && Array.isArray(v.messages);
}

export async function loadChat(): Promise<{ messages: unknown[]; calls: unknown[] }> {
  await ensureDirs();
  const c = await readJsonFile(CHAT_FILE, isChatShape);
  // Absent or quarantined: start empty rather than seeding a file, since an
  // empty transcript is not worth writing.
  return c ? { messages: c.messages, calls: Array.isArray(c.calls) ? c.calls : [] } : { messages: [], calls: [] };
}

export async function saveChat(chat: { messages: unknown[]; calls: unknown[] }): Promise<void> {
  await ensureDirs();
  await writeJsonFile(CHAT_FILE, chat);
}

export async function clearChat(): Promise<void> {
  try {
    if (await exists(CHAT_FILE, BASE)) await remove(CHAT_FILE, BASE);
  } catch (e) {
    logError(`persistence: failed to clear chat: ${String(e)}`);
  }
}

const DASHBOARDS_PATH = "dashboards";

export async function loadDashboards(): Promise<Dashboard[]> {
  await ensureDirs();
  
  if (loadDashboardsPromise) {
    return loadDashboardsPromise;
  }
  
  loadDashboardsPromise = (async () => {
    try {
      let entries: { name: string; isFile: boolean }[] = [];
      let dirReadFailed = false;
      try {
        entries = await readDir(DASHBOARDS_PATH, BASE);
      } catch (e) {
        logError(`persistence: failed to read dashboards directory: ${String(e)}`);
        dirReadFailed = true;
      }
      const out: Dashboard[] = [];
      for (const e of entries) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        const d = await readJsonFile(`${DASHBOARDS_PATH}/${e.name}`, isDashboardShape);
        if (d) out.push(d);
      }
      if (out.length === 0 && !dirReadFailed) {
        const main: Dashboard = { id: newId(), name: "Main", cards: [] };
        await saveDashboard(main);
        return [main];
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } finally {
      loadDashboardsPromise = null;
    }
  })();
  
  return loadDashboardsPromise;
}

export async function saveDashboard(d: Dashboard): Promise<void> {
  await ensureDirs();
  await writeJsonFile(`${DASHBOARDS_PATH}/${d.id}.json`, d);
}

export async function deleteDashboard(id: string): Promise<void> {
  const path = `${DASHBOARDS_PATH}/${id}.json`;
  try {
    if (await exists(path, BASE)) await remove(path, BASE);
  } catch (e) {
    logError(`persistence: failed to delete dashboard ${id}: ${String(e)}`);
  }
}

export async function deleteAllDashboards(): Promise<void> {
  const entries = await readDir(DASHBOARDS_PATH, BASE);
  for (const e of entries) {
    if (e.isFile && e.name.endsWith(".json")) {
      await deleteDashboard(e.name.replace(/\.json$/, ""));
    }
  }
}

export async function getSettings(): Promise<Settings> {
  return loadSettings();
}

export async function setSettings(settings: Settings): Promise<void> {
  await saveSettings(settings);
}

export async function getBackends(): Promise<BackendConfig[]> {
  return loadBackends();
}

export async function setBackends(backends: BackendConfig[]): Promise<void> {
  await saveBackends(backends);
}

export async function getDashboards(): Promise<Dashboard[]> {
  return loadDashboards();
}

export async function getDashboard(id: string): Promise<Dashboard | null> {
  const dashboards = await loadDashboards();
  return dashboards.find((d) => d.id === id) ?? null;
}
