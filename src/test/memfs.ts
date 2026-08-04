// In-memory stand-in for @tauri-apps/plugin-fs, installed via vi.mock in tests.
export const files = new Map<string, string>();
export const dirs = new Set<string>();
export function resetFs(): void { files.clear(); dirs.clear(); }

export const BaseDirectory = { AppData: 21 } as const;
type Opts = { baseDir?: number; recursive?: boolean; append?: boolean } | undefined;

export async function exists(path: string, _o?: Opts): Promise<boolean> {
  if (files.has(path) || dirs.has(path)) return true;
  const prefix = path.replace(/\/$/, "") + "/";
  for (const k of files.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

export async function mkdir(path: string, _o?: Opts): Promise<void> {
  dirs.add(path);
}

export async function readTextFile(path: string, _o?: Opts): Promise<string> {
  const v = files.get(path);
  if (v === undefined) throw new Error(`memfs: no such file: ${path}`);
  return v;
}

export async function writeTextFile(
  path: string, contents: string, o?: Opts
): Promise<void> {
  if (o?.append && files.has(path)) files.set(path, files.get(path)! + contents);
  else files.set(path, contents);
}

export async function readDir(
  path: string, _o?: Opts
): Promise<{ name: string; isFile: boolean }[]> {
  const prefix = path.replace(/\/$/, "") + "/";
  const names = new Set<string>();
  for (const k of files.keys()) {
    if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
  }
  return [...names].map((name) => ({ name, isFile: files.has(prefix + name) }));
}

export async function remove(path: string, _o?: Opts): Promise<void> {
  if (!files.has(path) && !dirs.has(path)) {
    throw new Error(`memfs: no such file or directory: ${path}`);
  }
  files.delete(path);
  dirs.delete(path);
}

export async function rename(
  oldPath: string, newPath: string, _o?: unknown
): Promise<void> {
  const v = files.get(oldPath);
  if (v === undefined) throw new Error(`memfs: no such file: ${oldPath}`);
  files.set(newPath, v);
  files.delete(oldPath);
}

export async function stat(path: string, _o?: Opts): Promise<{ size: number }> {
  const v = files.get(path);
  if (v === undefined) throw new Error(`memfs: no such file: ${path}`);
  return { size: new TextEncoder().encode(v).length };
}
