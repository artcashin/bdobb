import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

export const LOG_FILE = "logs/bdobb.log";
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

let queue: Promise<void> = Promise.resolve();

function getBaseDirOpts() {
  return { baseDir: BaseDirectory.AppData };
}

async function rotateIfNeeded(): Promise<void> {
  const logPath = LOG_FILE;
  
  if (!(await exists(logPath, getBaseDirOpts()))) return;

  const info = await stat(logPath, getBaseDirOpts());
  if (info.size < MAX_BYTES) return;

  // Delete oldest file if it exists (would exceed limit)
  if (await exists(`${logPath}.${MAX_FILES}`, getBaseDirOpts())) {
    await remove(`${logPath}.${MAX_FILES}`, getBaseDirOpts());
  }

  // Shift existing rotations up by 1
  for (let i = MAX_FILES - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (await exists(src, getBaseDirOpts())) {
      await rename(src, dst, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
      });
    }
  }

  // Move current log to .1
  if (await exists(logPath, getBaseDirOpts())) {
    await rename(logPath, `${logPath}.1`, {
      oldPathBaseDir: BaseDirectory.AppData,
      newPathBaseDir: BaseDirectory.AppData,
    });
  }
}

function formatMessage(message: string, args: unknown[]): string {
  let formatted = message;
  let argIndex = 0;

  while (formatted.includes("%s") && argIndex < args.length) {
    formatted = formatted.replace("%s", String(args[argIndex++]));
  }

  while (formatted.includes("%d") && argIndex < args.length) {
    formatted = formatted.replace("%d", String(args[argIndex++]));
  }

  while (formatted.includes("%j") && argIndex < args.length) {
    formatted = formatted.replace("%j", JSON.stringify(args[argIndex++]));
  }

  return formatted;
}

export async function init(): Promise<void> {
  try {
    await mkdir("logs", { baseDir: BaseDirectory.AppData, recursive: true });
  } catch (e) {
    console.error("logger init failed:", e);
  }
}

export function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  queue = queue.then(async () => {
    // Rotation is best-effort and must not take the write with it. Previously
    // both shared one try: a rename failing (an antivirus or another process
    // holding the file open, the canonical Windows case) lost the line AND
    // left the file oversized, so every subsequent line was lost too — with
    // console.error as the only channel, on the platform the log exists for.
    try {
      await init();
    } catch (e) {
      console.error("logger init failed:", e);
    }
    try {
      await rotateIfNeeded();
    } catch (e) {
      console.error("logger rotation failed (continuing to append):", e);
    }

    try {
      const formatted = formatMessage(message, args);
      const timestamp = new Date().toISOString();
      const levelStr = level.toUpperCase();
      // Collapse newlines: one entry per line, or any reader or viewer that
      // parses the file sees a stack trace as several malformed entries.
      const oneLine = formatted.replace(/\r?\n/g, "\\n");
      const logLine = `${timestamp} | ${levelStr} | ${oneLine}\n`;

      await writeTextFile(LOG_FILE, logLine, {
        baseDir: BaseDirectory.AppData,
        append: true,
      });
    } catch (e) {
      console.error("logger write failed:", e);
    }
  });
}

export function debug(message: string, ...args: unknown[]): void {
  log("debug", message, ...args);
}

export function info(message: string, ...args: unknown[]): void {
  log("info", message, ...args);
}

export function warn(message: string, ...args: unknown[]): void {
  log("warn", message, ...args);
}

export function error(message: string, ...args: unknown[]): void {
  log("error", message, ...args);
}

// Desk semantics: logError also echoes to the console, so an error is
// visible immediately in a dev/debug session and not only on the next log
// file read. Kept distinct from `error` (used internally for the "error"
// log level, including from formatMessage-style call sites) so that
// console output stays tied to the public logError entry point.
export function logError(message: string): void {
  console.error(message);
  error(message);
}

// Dedup by key: hardening from desk's SSE/MCP paths, where a retried
// connection or a polling loop would otherwise write the same failure to the
// log on every attempt.
const seen = new Set<string>();
export function logOnce(key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  logError(message);
}

export async function flush(): Promise<void> {
  await queue;
}

export async function close(): Promise<void> {
  await queue;
}

/** Last `maxLines` non-empty lines of the log file, oldest first. */
export async function readLogTail(maxLines: number): Promise<string[]> {
  if (!(await exists(LOG_FILE, getBaseDirOpts()))) return [];
  const text = await readTextFile(LOG_FILE, getBaseDirOpts());
  return text.split("\n").filter((l) => l !== "").slice(-maxLines);
}

/** Absolute path for display in the Settings dialog. */
export async function getLogPath(): Promise<string> {
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  return join(await appDataDir(), LOG_FILE);
}
